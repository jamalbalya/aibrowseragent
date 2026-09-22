/**
 * The form controls whose value is structured rather than typed (P-006).
 *
 * In a module of its own because both sides of the page need it and they
 * already point at each other: the interaction engine imports the element
 * registry from the semantic tree, so the tree importing the engine back
 * would close a cycle. A shared constant with no dependencies of its own
 * cannot.
 *
 * What makes these controls a set worth naming: each holds a value the
 * browser parses and normalises for itself. A date field is `textbox` to an
 * accessibility tree, and typing into one types into whichever segment has
 * focus — so the type has to reach the model, and the value has to be set
 * rather than typed.
 */
export const STRUCTURED_INPUT_TYPES = [
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'color',
  'range',
  'number',
] as const;

export type StructuredInputType = (typeof STRUCTURED_INPUT_TYPES)[number];
