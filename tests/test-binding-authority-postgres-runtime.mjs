// Requires the owned local-cluster runner. The shared runtime assertions retain
// their real signatures, HTTP, durable ledger, SQLite and WebSocket checks.
process.env.RAGENT_TEST_BINDING_RUNTIME_POSTGRES = '1';
await import('./test-binding-authority-runtime.mjs');
