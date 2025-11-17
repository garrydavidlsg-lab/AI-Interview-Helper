export enum InterviewStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  LISTENING = 'LISTENING',
  ERROR = 'ERROR',
  ENDED = 'ENDED',
}

export interface TranscriptTurn {
  speaker: 'user' | 'model';
  text: string;
  isFinal: boolean;
  timestamp: number;
}
