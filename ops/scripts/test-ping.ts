import { Client, GatewayIntentBits } from "discord.js";
import { resolveControlEnvironment } from "../../control/start.ts";
import { FileSecretSource } from "../../secrets/loader.ts";

async function main() {
  const source = new FileSecretSource();
  const env = await resolveControlEnvironment("glue", process.env as NodeJS.ProcessEnv, source);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  
  client.on("ready", async () => {
    console.log(`Logged in as ${client.user?.tag}!`);
    const channelId = process.env.DISCORD_STATUS_CHANNEL_ID;
    if (channelId) {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await channel.send("Ping from JOC/Sovereign test-ping!");
        console.log("Ping sent successfully!");
      }
    }
    client.destroy();
  });
  
  await client.login(env.DISCORD_BOT_TOKEN);
}

main().catch(console.error);
