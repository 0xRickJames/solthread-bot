import "dotenv/config";
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

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, FRONTEND_URL, PORT } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !FRONTEND_URL) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// Initialize Discord bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Initialize Express webhook server
const app = express();
app.use(bodyParser.json());

// Bot Ready
client.once("ready", () => console.log(`Logged in as ${client.user?.tag}`));

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
      const link = `${FRONTEND_URL}/verify?discordId=${discordId}`;

      const embed = new EmbedBuilder()
        .setTitle("Verify Your Wallet")
        .setDescription(`[Click here to verify your wallet](${link})`)
        .setColor(0x00ff99)
        .setFooter({ text: "You only need to verify once." });

      await interaction.reply({ embeds: [embed], ephemeral: true });
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
        embed.setFooter({ text: footerText, iconURL: footerUrl || "" });
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
      const link = `${FRONTEND_URL}/verify?discordId=${discordId}`;

      const embed = new EmbedBuilder()
        .setTitle("Verify Your Wallet")
        .setDescription(`[Click here to verify your wallet](${link})`)
        .setColor(0x00ff99)
        .setFooter({ text: "You only need to verify once." });

      await interaction.reply({ embeds: [embed], ephemeral: true });
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
    const guild = await client.guilds.fetch(GUILD_ID!);
    const member = await guild.members.fetch(discordId);

    for (const roleId of roles) {
      try {
        await member.roles.add(roleId);
        console.log(`Assigned role ${roleId} to ${discordId}`);
      } catch (err) {
        console.error(`Failed to assign role ${roleId} to ${discordId}:`, err);
      }
    }

    res.send("Roles assigned");
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
