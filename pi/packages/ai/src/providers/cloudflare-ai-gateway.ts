import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";

// FORK(blueberry): dropped "openai-completions" — the generated model data
// no longer declares any openai-completions models for this provider, so the
// type union fails tsgo at upstream HEAD. Builds must be deterministic
// offline (build:offline); catalog drift cannot break our build.
export function cloudflareAIGatewayProvider(): Provider<"anthropic-messages" | "openai-responses"> {
	return createProvider({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		auth: { apiKey: cloudflareAIGatewayAuth() },
		models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
		api: {
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
	});
}
