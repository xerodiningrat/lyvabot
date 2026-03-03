require("dotenv").config();
const { Client, Collection, GatewayIntentBits, Events, MessageFlags, REST, Routes } = require("discord.js");
const reviewCommand = require("./commands/review");
const assetCommand = require("./commands/asset");
const menuCommand = require("./commands/menu");
const verifyCommand = require("./commands/verify");
const { startDashboard } = require("./dashboard/server");
const { ingestDiscordMessage, backfillNewsFromClient } = require("./news/feed");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const autoSyncGuildCommands = process.env.AUTO_SYNC_GUILD_COMMANDS !== "false";
const enableMessageContentIntent = process.env.DISCORD_ENABLE_MESSAGE_CONTENT_INTENT === "true";
if (!token) {
  throw new Error("DISCORD_TOKEN belum di-set di environment.");
}

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (enableMessageContentIntent) intents.push(GatewayIntentBits.MessageContent);

const client = new Client({
  intents,
});

client.commands = new Collection();
client.commands.set(reviewCommand.data.name, reviewCommand);
client.commands.set(assetCommand.data.name, assetCommand);
client.commands.set(menuCommand.data.name, menuCommand);
client.commands.set(verifyCommand.data.name, verifyCommand);

const rest = clientId ? new REST({ version: "10" }).setToken(token) : null;

function getCommandsBody() {
  return [...client.commands.values()].map((command) => command.data.toJSON());
}

async function syncGuildCommands(guildId) {
  if (!rest || !clientId || !guildId) return;
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: getCommandsBody(),
  });
}

client.once(Events.ClientReady, (c) => {
  console.log(`Bot online as ${c.user.tag}`);
  if (!enableMessageContentIntent) {
    console.log("Message Content Intent: OFF (set DISCORD_ENABLE_MESSAGE_CONTENT_INTENT=true jika ingin baca isi pesan penuh).");
  }

  backfillNewsFromClient(c, 20)
    .then((result) => {
      if (!result) return;
      console.log(
        `News backfill selesai. Channels: ${result.scannedChannels || 0}, Upserts: ${result.upserts || 0}`,
      );
    })
    .catch((error) => {
      console.error("News backfill error", error?.message || error);
    });

  if (!autoSyncGuildCommands) {
    console.log("Auto sync guild commands: disabled (AUTO_SYNC_GUILD_COMMANDS=false)");
    return;
  }

  if (!clientId || !rest) {
    console.log("Auto sync guild commands: skipped (DISCORD_CLIENT_ID belum di-set).");
    return;
  }

  (async () => {
    const guilds = [...c.guilds.cache.values()];
    let ok = 0;
    let fail = 0;

    for (const guild of guilds) {
      try {
        await syncGuildCommands(guild.id);
        ok += 1;
      } catch (error) {
        fail += 1;
        console.error(`Auto sync gagal untuk guild ${guild.id}`, error?.code || error?.message || error);
      }
    }

    console.log(`Auto sync startup selesai. Success: ${ok}, Failed: ${fail}`);
  })().catch((error) => {
    console.error("Auto sync startup error", error);
  });
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await ingestDiscordMessage(message);
  } catch (error) {
    console.error("News ingest error", error?.message || error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    for (const command of client.commands.values()) {
      if (typeof command.handleButton !== "function") continue;
      try {
        const handled = await command.handleButton(interaction);
        if (handled) return;
      } catch (error) {
        console.error("Button handler error", error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction
            .reply({
              content: "Terjadi error saat memproses tombol.",
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        }
        return;
      }
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command || typeof command.autocomplete !== "function") return;
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      console.error("Autocomplete error", error);
      await interaction.respond([]).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    const message = "Terjadi error saat menjalankan command.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.on(Events.GuildCreate, async (guild) => {
  if (!autoSyncGuildCommands || !rest || !clientId) return;

  try {
    await syncGuildCommands(guild.id);
    console.log(`Auto sync on join berhasil untuk guild ${guild.id}`);
  } catch (error) {
    console.error(`Auto sync on join gagal untuk guild ${guild.id}`, error?.code || error?.message || error);
  }
});

startDashboard({
  client,
  rest,
  clientId,
  getCommandsBody,
  syncGuildCommands,
});

client.login(token);

