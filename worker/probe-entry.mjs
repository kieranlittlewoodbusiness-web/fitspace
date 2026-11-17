// E2 entry: probes only (no app code), so one failing import cannot hide the others.
import { handleProbe } from './probes.mjs';
export default { fetch: request => handleProbe(request) };
