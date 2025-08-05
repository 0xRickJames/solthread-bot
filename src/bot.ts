import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
} from "discord.js";

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

// Register /verify slash command
const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
async function registerCommands() {
  const commands = [
    { name: "verify", description: "Get your wallet verification link" },
  ];
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID!, GUILD_ID!), {
    body: commands,
  });
}

// Slash command for verification link
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
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
});

// Webhook to assign multiple roles
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
