import { verifyAisaConnection } from '../server/aisa-connection.mjs';

const result = await verifyAisaConnection();
console.log(result.message);
if (!result.connected) process.exitCode = 1;
