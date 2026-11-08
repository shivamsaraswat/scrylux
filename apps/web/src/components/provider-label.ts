// How a provider is named to a person (Phase 3 Milestones 3 and 4): by the service, never by the operator's model name or address.
// Looked up here, so a name is always a fixed string of Scrylux's own and never text that came from a request.
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  'openai-compatible': 'an OpenAI-compatible service',
  bedrock: 'Amazon Bedrock',
  gemini: 'Google Gemini',
};

export const providerLabel = (provider: string): string => PROVIDER_LABEL[provider] ?? provider;
