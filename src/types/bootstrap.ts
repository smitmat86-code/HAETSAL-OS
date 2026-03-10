// src/types/bootstrap.ts
// Bootstrap import types — Workflow params, interview state, import progress

export type BootstrapStatus =
  | 'not_started'
  | 'interview_in_progress'
  | 'interview_complete'
  | 'import_in_progress'
  | 'completed'

export interface BootstrapParams {
  tenantId: string
  skipInterview?: boolean
  importMonthsGmail?: number   // default 12
  importMonthsCalendar?: number // default 24
  importMonthsDrive?: number    // default 36
}

export interface InterviewDomain {
  domain: string
  questions: string[]
}

export interface InterviewState {
  domainIndex: number
  questionIndex: number
  answers: Array<{ domain: string; question: string; answer: string }>
}

export interface ImportProgress {
  gmailImported: number
  calendarImported: number
  driveImported: number
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

export const INTERVIEW_DOMAINS: InterviewDomain[] = [
  {
    domain: 'identity',
    questions: [
      "What's your name and what should I call you?",
      "What's your current role and what are you working toward professionally?",
      "What matters most to you in life right now — what are you optimizing for?",
    ],
  },
  {
    domain: 'career',
    questions: [
      'What are your top 3 career goals for the next 12 months?',
      "What's your biggest current challenge at work?",
      'Who are the most important people in your professional life?',
    ],
  },
  {
    domain: 'health',
    questions: [
      'What health habits are you actively maintaining or trying to build?',
      'What is your current fitness or wellness routine, if any?',
    ],
  },
  {
    domain: 'relationships',
    questions: [
      'Who are the most important people in your personal life right now?',
      'Is there any relationship you are actively investing in or working on?',
    ],
  },
  {
    domain: 'finance',
    questions: [
      'What are your main financial goals for the next year?',
      'Are there any financial commitments or constraints I should be aware of?',
    ],
  },
]
