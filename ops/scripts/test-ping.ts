import { Client, GatewayIntentBits } from "discord.js";
import { resolveControlEnvironment } from "../../control/start.ts";
import { secretSourceFromEnv } from "../../secrets/loader.ts";

async function main() {
  const source = secretSourceFromEnv(process.env, process.env.GCLOUD_PROJECT ?? "");
  const env = await resolveControlEnvironment("discord-bot", process.env, source);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  
  client.on("ready", async () => {
    console.log(`Logged in as ${client.user?.tag}!`);
    const channelId = process.env.DISCORD_STATUS_CHANNEL_ID;
    if (channelId) {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isSendable()) {
        await channel.send("Ping from JOC/Sovereign test-ping!");
        console.log("Ping sent successfully!");
      }
    }
    client.destroy();
  });
  
  await client.login(env.DISCORD_BOT_TOKEN);
}

main().catch(console.error);
