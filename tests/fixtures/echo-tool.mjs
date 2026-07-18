export const tools = [
  {
    name: 'echo',
    description: 'echo back text',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: (args) => ({ echo: args.text }),
  },
];
