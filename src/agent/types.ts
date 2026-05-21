export interface VoiceAgentContext {
  sessionId: string;
  userId?: string;
  homeAssistant?: {
    baseUrl?: string;
    token?: string;
  };
}

export interface RunVoiceAgentInput {
  sessionId: string;
  text: string;
  userId?: string;
}

export interface RunVoiceAgentOutput {
  text: string;
}
