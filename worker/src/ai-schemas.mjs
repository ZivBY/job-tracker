// Anthropic's native JSON output grammar supports these basic types/enums.
// Bounds (length, item count, evidence index, real calendar date) stay in the
// local validators because several JSON Schema bound keywords are unsupported.
const closedObject = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const JOB_TYPES = Object.freeze(['', 'Full-time', 'Contract', 'Part-time']);
export const ROUND_TYPES = Object.freeze(['Phone screen', '1:1 Interview', 'Hiring manager interview', 'Panel interview', 'Presentation interview', 'Case study interview', 'Technical interview', 'Take-home assignment', 'Culture fit interview', 'Other']);
export const JOB_SCHEMA = closedObject({
  company: { type: 'string' }, role: { type: 'string' }, location: { type: 'string' },
  type: { type: 'string', enum: JOB_TYPES },
  url: { type: 'string', enum: [''] },
  postedDate: { type: 'string' }, salary: { type: 'string' }
});
export const SUGGESTIONS_SCHEMA = {
  type: 'array',
  items: closedObject({
    company: { type: 'string' },
    suggestedStage: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
    reason: { type: 'string' },
    emailIndex: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    interviewRounds: { type: 'array', items: closedObject({ type: { type: 'string', enum: ROUND_TYPES }, notes: { type: 'string' } }) }
  })
};
