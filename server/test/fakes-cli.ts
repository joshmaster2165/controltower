/** Starts the fake Gemini/Bedrock/Vertex upstreams and prints their URLs as one JSON line. Used by e2e. */
import { fakeBedrock, fakeGemini, fakeServiceAccount, fakeVertex } from './fakes.js';

const [gemini, bedrock, vertex] = await Promise.all([fakeGemini(), fakeBedrock(), fakeVertex()]);
process.stdout.write(JSON.stringify({ gemini: gemini.url, bedrock: bedrock.url, vertex: vertex.url, serviceAccount: fakeServiceAccount(`${vertex.url}/token`) }) + '\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => undefined, 60_000);
