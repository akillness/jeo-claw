
import { parseCommand } from "../discord/commands.ts";
import { authorizeEvent, policyFromEnv } from "../discord/bot.ts";

const mockEnv = {
    DISCORD_GUILD_ID: "123",
    DISCORD_REQUEST_CHANNEL_ID: "req-1",
    DISCORD_APPROVAL_CHANNEL_ID: "app-1",
    DISCORD_APPROVER_ROLE_ID: "admin-role",
    GLUE_EVENT_ENDPOINT: "http://localhost:8787",
    JEO_CONTROL_EVENT_SECRET: "secret"
};

const policy = policyFromEnv(mockEnv);

function testCommand(input: string, user: string, channelId: string, roles: string[]) {
    const event = parseCommand(input, user);
    const context = {
        guildId: "123",
        channelId: channelId,
        member: {
            roles: { cache: { has: (id: string) => roles.includes(id) } },
            permissions: { has: () => false }
        }
    };
    const auth = authorizeEvent(event as any, context, policy);
    console.log(`[${input}] -> type: ${event.type}, auth: ${auth.ok ? "PASS" : "FAIL (" + auth.reason + ")"}`);
}

console.log("--- Discord Command & Auth Smoke Test ---");
testCommand("request zeroclaw fix bug", "user1", "req-1", []);
testCommand("request nullclaw feature", "user1", "app-1", []); // Wrong channel
testCommand("approve wf-1 pr.create", "admin", "app-1", ["admin-role"]);
testCommand("approve wf-1 pr.create", "user1", "app-1", []); // No permission
testCommand("config set autonomy supervised", "admin", "app-1", ["admin-role"]);
