/** Provider-neutral description of what we want back. Each adapter translates it. */
export const TASK_FIELDS = {
  title: 'Short imperative task title, understandable months later without the chat.',
  assignee: 'Roster name of who must do it, or null.',
  dueDate: 'yyyy-mm-dd, or null if none implied.',
  priority: 'low | medium | high',
  notes: 'One or two lines of context worth keeping, or null.',
  quote: 'Verbatim message that established the task, max 200 chars.',
  confidence: 'Number 0 to 1.',
};

export const REQUIRED = ['title', 'assignee', 'dueDate', 'priority', 'notes', 'quote', 'confidence'];

/** Anthropic tool-use schema. */
export const anthropicTool = {
  name: 'record_tasks',
  description: 'Record the actionable tasks found in the conversation. Call with an empty array if there are none.',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: TASK_FIELDS.title },
            assignee: { type: ['string', 'null'], description: TASK_FIELDS.assignee },
            dueDate: { type: ['string', 'null'], description: TASK_FIELDS.dueDate },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            notes: { type: ['string', 'null'], description: TASK_FIELDS.notes },
            quote: { type: 'string', description: TASK_FIELDS.quote },
            confidence: { type: 'number', description: TASK_FIELDS.confidence },
          },
          required: REQUIRED,
        },
      },
    },
    required: ['tasks'],
  },
};

/** Gemini responseSchema (OpenAPI subset). */
export const geminiSchema = {
  type: 'OBJECT',
  properties: {
    tasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: TASK_FIELDS.title },
          assignee: { type: 'STRING', nullable: true, description: TASK_FIELDS.assignee },
          dueDate: { type: 'STRING', nullable: true, description: TASK_FIELDS.dueDate },
          priority: { type: 'STRING', enum: ['low', 'medium', 'high'] },
          notes: { type: 'STRING', nullable: true, description: TASK_FIELDS.notes },
          quote: { type: 'STRING', description: TASK_FIELDS.quote },
          confidence: { type: 'NUMBER', description: TASK_FIELDS.confidence },
        },
        required: REQUIRED,
        propertyOrdering: REQUIRED,
      },
    },
  },
  required: ['tasks'],
};
