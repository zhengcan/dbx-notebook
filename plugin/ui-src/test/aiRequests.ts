export const GEN_METHODS = ['host.ai.generateText', 'host.ai.generateTextStream']
/** Every host.ai generation request (one-shot or streaming) recorded on the request channel. */
export const genRequests = (bridge: { calls: unknown[] }) => (bridge.calls as any[]).filter((c) => c.method === 'request' && GEN_METHODS.includes(c.args.method))
export const genPrompts = (bridge: { calls: unknown[] }) => genRequests(bridge).map((c) => c.args.params.prompt as string)
/** host.ai.* traffic on either channel. */
export const hostAiCalls = (bridge: { calls: unknown[] }, re = /^host\.ai\./) => (bridge.calls as any[]).filter((c) => (c.method === 'request' || c.method === 'invoke') && re.test(String(c.args?.method)))
