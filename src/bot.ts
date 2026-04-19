import "dotenv/config";
import axios from "axios";
import express from "express";
import bodyParser from "body-parser";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import type { Interaction } from "discord.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { MongoClient } from "mongodb";

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  FRONTEND_URL,
  PORT,
  BOT_INTERNAL_SECRET,
  MONGODB_URI,
  SOLANA_RPC,
  TOKEN_MINT,
  ROLE_ANY,
  ROLE_1K,
  ROLE_10K,
  ROLE_100K,
  ROLE_LP,
  REFRESH_INTERVAL_MS,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !FRONTEND_URL || !BOT_INTERNAL_SECRET) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const VERIFY_API_URL = "https://verify.omnipair.fi/api/issue-verify-token";
const VERIFY_LINK_BASE = "https://verify.omnipair.fi/verify";

const MANAGED_ROLES = [ROLE_ANY, ROLE_1K, ROLE_10K, ROLE_100K, ROLE_LP].filter(Boolean) as string[];

const OMFG_MINT = "omfgRBnxHsNJh6YeGbGAmWenNkenzsXyBXm3WDhmeta";
const INDEXER_URL = "https://api.indexer.omnipair.fi/api/v1/positions/liquidity";

interface LiquidityPosition {
  signer: string;
  token0Mint: string;
  token1Mint: string;
  lpAmount: string;
}

async function fetchLpHolderWallets(): Promise<Set<string>> {
  const holders = new Set<string>();
  let offset = 0;

  while (true) {
    const res = await fetch(`${INDEXER_URL}?status=open&limit=100&offset=${offset}`);
    if (!res.ok) throw new Error(`Indexer API error: ${res.status}`);
    const { data } = await res.json() as { data: { positions: LiquidityPosition[]; pagination: { hasNext: boolean } } };

    for (const p of data.positions) {
      const isOmfgPair = p.token0Mint === OMFG_MINT || p.token1Mint === OMFG_MINT;
      if (isOmfgPair && BigInt(p.lpAmount) > 0n) {
        holders.add(p.signer);
      }
    }

    if (!data.pagination.hasNext) break;
    offset += 100;
  }

  return holders;
}

interface IssueTokenResponse {
  token: string;
  expiresAt: string;
}

async function issueVerifyToken(discordId: string): Promise<IssueTokenResponse> {
  const res = await axios.post<IssueTokenResponse>(
    VERIFY_API_URL,
    { discordId },
    {
      headers: {
        Authorization: `Bearer ${BOT_INTERNAL_SECRET}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    }
  );

  if (res.status === 401) {
    console.error(
      "Verification API returned 401: BOT_INTERNAL_SECRET is wrong or missing."
    );
    throw new Error(
      "Verification service is misconfigured. Please contact the server administrator."
    );
  }

  if (res.status >= 400) {
    console.error(
      `Verification API error ${res.status}:`,
      JSON.stringify(res.data)
    );
    throw new Error(
      "Verification service is temporarily unavailable. Please try again later."
    );
  }

  return res.data;
}

// Shared role sync — add/remove only the roles we manage
async function syncMemberRoles(discordId: string, roles: string[]) {
  const guild = await client.guilds.fetch(GUILD_ID!);
  const member = await guild.members.fetch(discordId);
  const currentRoles = member.roles.cache.map((r) => r.id);

  const rolesToRemove = currentRoles.filter(
    (id) => MANAGED_ROLES.includes(id) && !roles.includes(id)
  );
  const rolesToAdd = roles.filter((id) => !currentRoles.includes(id));

  for (const roleId of rolesToRemove) {
    try {
      await member.roles.remove(roleId);
      console.log(`Removed role ${roleId} from ${discordId}`);
    } catch (err) {
      console.error(`Failed to remove role ${roleId} from ${discordId}:`, err);
    }
  }

  for (const roleId of rolesToAdd) {
    try {
      await member.roles.add(roleId);
      console.log(`Assigned role ${roleId} to ${discordId}`);
    } catch (err) {
      console.error(`Failed to assign role ${roleId} to ${discordId}:`, err);
    }
  }
}

// Background job: re-check all verified wallets and sync roles
async function refreshAllRoles() {
  if (!MONGODB_URI || !SOLANA_RPC || !TOKEN_MINT) {
    console.warn("refreshAllRoles: MONGODB_URI, SOLANA_RPC, or TOKEN_MINT not set — skipping.");
    return;
  }

  console.log("refreshAllRoles: starting run...");
  const mongo = new MongoClient(MONGODB_URI);

  try {
    await mongo.connect();
    const wallets = await mongo
      .db()
      .collection("wallets")
      .find({ status: "active" })
      .toArray();

    // Group wallet addresses by discordId
    const byUser: Record<string, string[]> = {};
    for (const w of wallets) {
      if (!byUser[w.discordId]) byUser[w.discordId] = [];
      byUser[w.discordId].push(w.address);
    }

    const conn = new Connection(SOLANA_RPC, "confirmed");
    const tokenMint = new PublicKey(TOKEN_MINT);

    let lpHolders = new Set<string>();
    try {
      lpHolders = await fetchLpHolderWallets();
      console.log(`refreshAllRoles: ${lpHolders.size} LP holder wallets found`);
    } catch (err) {
      console.error("refreshAllRoles: failed to fetch LP holders, skipping LP role:", err);
    }

    let updated = 0;
    let skipped = 0;

    for (const [discordId, addresses] of Object.entries(byUser)) {
      let total = 0;
      for (const addr of addresses) {
        try {
          const accounts = await conn.getParsedTokenAccountsByOwner(
            new PublicKey(addr),
            { mint: tokenMint }
          );
          for (const acc of accounts.value) {
            total += acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
          }
        } catch (err) {
          console.error(`refreshAllRoles: failed to check balance for ${addr}:`, err);
        }
      }

      const roles: string[] = [];
      if (total > 0 && ROLE_ANY) roles.push(ROLE_ANY);
      if (total >= 1_000 && ROLE_1K) roles.push(ROLE_1K);
      if (total >= 10_000 && ROLE_10K) roles.push(ROLE_10K);
      if (total >= 100_000 && ROLE_100K) roles.push(ROLE_100K);
      if (ROLE_LP && addresses.some((addr) => lpHolders.has(addr))) roles.push(ROLE_LP);

      try {
        await syncMemberRoles(discordId, roles);
        updated++;
      } catch (err) {
        // Member may have left the guild
        console.warn(`refreshAllRoles: could not sync roles for ${discordId}:`, err);
        skipped++;
      }
    }

    console.log(`refreshAllRoles: done. ${updated} updated, ${skipped} skipped.`);
  } finally {
    await mongo.close();
  }
}

// Initialize Discord bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Initialize Express webhook server
const app = express();
app.use(bodyParser.json());

// Bot Ready — start background refresh loop
client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);

  const intervalMs = parseInt(REFRESH_INTERVAL_MS || "") || 60 * 60 * 1000; // default: 1 hour
  console.log(`Role refresh scheduled every ${intervalMs / 1000}s`);

  // Run once shortly after startup, then on interval
  setTimeout(() => refreshAllRoles(), 30_000);
  setInterval(() => refreshAllRoles(), intervalMs);
});

// Register slash commands
const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
async function registerCommands() {
  const commands = [
    { name: "verify", description: "Get your wallet verification link" },
    {
      name: "createverifyembed",
      description: "Create a verification embed with a button",
      options: [
        {
          name: "channel",
          description: "Channel to send the embed to",
          type: 7, // CHANNEL
          required: true,
        },
        { name: "title", description: "Embed title", type: 3 },
        { name: "description", description: "Embed description", type: 3 },
        {
          name: "color",
          description: "Embed color hex (e.g. #00ff99)",
          type: 3,
        },
        { name: "footer_text", description: "Footer text", type: 3 },
        { name: "footer_url", description: "Footer icon URL", type: 3 },
        { name: "thumbnail", description: "Thumbnail URL", type: 3 },
        { name: "image", description: "Large image URL", type: 3 },
      ],
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    },
  ];

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID!), {
    body: commands,
  });
}

// Unified interaction handler
client.on("interactionCreate", async (interaction: Interaction) => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    // /verify
    if (interaction.commandName === "verify") {
      const discordId = interaction.user.id;
      try {
        const { token } = await issueVerifyToken(discordId);
        const link = `${VERIFY_LINK_BASE}?token=${token}`;

        const embed = new EmbedBuilder()
          .setTitle("Verify Your Wallet")
          .setDescription(`[Click here to verify your wallet](${link})`)
          .setColor(0x00ff99)
          .setFooter({ text: "Link expires in 10 minutes." });

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to get verification link.";
        await interaction.reply({
          content: `❌ ${message}`,
          ephemeral: true,
        });
      }
    }

    // /createverifyembed
    if (interaction.commandName === "createverifyembed") {
      const channel = interaction.options.getChannel("channel", true);
      if (channel?.type !== ChannelType.GuildText) {
        return interaction.reply({
          content: "Please select a text channel.",
          ephemeral: true,
        });
      }

      const title =
        interaction.options.getString("title") || "Verify Your Wallet";
      const description =
        interaction.options.getString("description") ||
        "Click the button below to verify your wallet and get your roles!";
      const colorHex = interaction.options.getString("color") || "#00ff99";
      const footerText = interaction.options.getString("footer_text") || "";
      const footerUrl = interaction.options.getString("footer_url") || "";
      const thumbnail = interaction.options.getString("thumbnail") || "";
      const image = interaction.options.getString("image") || "";

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(parseInt(colorHex.replace("#", ""), 16));

      if (footerText)
        embed.setFooter(
          footerUrl
            ? { text: footerText, iconURL: footerUrl }
            : { text: footerText }
        );
      if (thumbnail) embed.setThumbnail(thumbnail);
      if (image) embed.setImage(image);

      const button = new ButtonBuilder()
        .setCustomId("verify_button")
        .setLabel("Verify Wallet")
        .setStyle(ButtonStyle.Success);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

      await (channel as any).send({ embeds: [embed], components: [row] });
      await interaction.reply({
        content: `Verification embed created in ${channel}`,
        ephemeral: true,
      });
    }
  }

  // Button interactions
  if (interaction.isButton()) {
    if (interaction.customId === "verify_button") {
      const discordId = interaction.user.id;
      try {
        const { token } = await issueVerifyToken(discordId);
        const link = `${VERIFY_LINK_BASE}?token=${token}`;

        const embed = new EmbedBuilder()
          .setTitle("Verify Your Wallet")
          .setDescription(`[Click here to verify your wallet](${link})`)
          .setColor(0x00ff99)
          .setFooter({ text: "Link expires in 10 minutes." });

        await interaction.reply({ embeds: [embed], ephemeral: true });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to get verification link.";
        await interaction.reply({
          content: `❌ ${message}`,
          ephemeral: true,
        });
      }
    }
  }
});

// Webhook to assign roles
app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook payload:", req.body);
  const { discordId, roles } = req.body;

  if (!discordId || !roles || !Array.isArray(roles)) {
    console.log("Invalid payload:", req.body);
    return res.status(400).send("Invalid payload");
  }

  try {
    await syncMemberRoles(discordId, roles);
    res.send("Roles synchronized");
  } catch (err) {
    console.error("Error assigning roles:", err);
    res.status(500).send("Error assigning roles");
  }
});

// Start Express webhook server
app.listen(Number(PORT) || 3001, () =>
  console.log(`Webhook listening on port ${PORT || 3001}`)
);

// Start bot
client.login(DISCORD_TOKEN);
registerCommands();
