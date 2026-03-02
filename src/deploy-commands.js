require("dotenv").config();
const { REST, Routes } = require("discord.js");
const reviewCommand = require("./commands/review");
const assetCommand = require("./commands/asset");
const menuCommand = require("./commands/menu");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const guildIdsRaw = process.env.DISCORD_GUILD_IDS || "";
const deployTarget = (process.env.DEPLOY_TARGET || "guild").toLowerCase();
const fallbackToGlobal = process.env.DEPLOY_FALLBACK_GLOBAL === "true";
const clearGlobalOnGuildDeploy = process.env.CLEAR_GLOBAL_ON_GUILD_DEPLOY !== "false";

if (!token || !clientId) {
  throw new Error("DISCORD_TOKEN dan DISCORD_CLIENT_ID wajib di-set.");
}

const rest = new REST({ version: "10" }).setToken(token);
const commandsBody = [reviewCommand.data.toJSON(), assetCommand.data.toJSON(), menuCommand.data.toJSON()];

function parseGuildIds() {
  const ids = guildIdsRaw
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);

  if (guildId && !ids.includes(guildId)) {
    ids.push(guildId);
  }

  return [...new Set(ids)];
}

async function deployToGuild(targetGuildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, targetGuildId), {
    body: commandsBody,
  });
}

async function deployToGlobal() {
  await rest.put(Routes.applicationCommands(clientId), {
    body: commandsBody,
  });
}

async function clearGlobalCommands() {
  await rest.put(Routes.applicationCommands(clientId), {
    body: [],
  });
}

(async () => {
  try {
    if (deployTarget === "global") {
      console.log("Deploying slash commands globally...");
      await deployToGlobal();
      console.log("Global slash commands deployed.");
      return;
    }

    const guildIds = parseGuildIds();
    if (guildIds.length === 0) {
      throw new Error("Set DISCORD_GUILD_ID atau DISCORD_GUILD_IDS untuk deploy target guild.");
    }

    const success = [];
    const failed = [];

    for (const targetGuildId of guildIds) {
      try {
        console.log(`Deploying slash commands to guild ${targetGuildId}...`);
        await deployToGuild(targetGuildId);
        success.push(targetGuildId);
      } catch (error) {
        failed.push({ guildId: targetGuildId, error });
      }
    }

    console.log(`Guild deploy done. Success: ${success.length}, Failed: ${failed.length}`);
    if (success.length > 0) {
      console.log(`Guild success IDs: ${success.join(", ")}`);
    }

    if (failed.length === 0) {
      if (clearGlobalOnGuildDeploy) {
        try {
          console.log("Membersihkan global commands untuk mencegah command double...");
          await clearGlobalCommands();
          console.log("Global commands dibersihkan.");
        } catch (clearError) {
          console.error("Gagal membersihkan global commands.");
          console.error(clearError);
        }
      }
      return;
    }

    failed.forEach(({ guildId: failedGuildId, error }) => {
      if (error && error.code === 50001) {
        console.error(
          `Missing Access ke guild ${failedGuildId}. Pastikan bot sudah join guild itu dan punya scope "applications.commands".`,
        );
        return;
      }
      console.error(`Guild deploy gagal untuk ${failedGuildId}`);
      console.error(error);
    });

    if (fallbackToGlobal) {
      try {
        console.log("Mencoba fallback deploy global...");
        await deployToGlobal();
        console.log("Global slash commands deployed (fallback berhasil).");
        return;
      } catch (globalError) {
        console.error("Fallback global deploy gagal.");
        console.error(globalError);
      }
    }

    process.exit(1);
  } catch (error) {
    const isMissingAccess = error && error.code === 50001;

    if (isMissingAccess) {
      console.error(
        `Missing Access saat deploy. Pastikan bot sudah join guild target dan punya scope "applications.commands".`,
      );

      if (fallbackToGlobal) {
        try {
          console.log("Mencoba fallback deploy global...");
          await deployToGlobal();
          console.log("Global slash commands deployed (fallback berhasil).");
          return;
        } catch (globalError) {
          console.error("Fallback global deploy gagal.");
          console.error(globalError);
          process.exit(1);
        }
      }
    }

    console.error(error);
    process.exit(1);
  }
})();
