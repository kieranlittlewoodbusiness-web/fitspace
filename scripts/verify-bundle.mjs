import { zipFunctions } from '@netlify/zip-it-and-ship-it';
import { resolve } from 'node:path';
const result = await zipFunctions(resolve('netlify/functions'), resolve('.netlify/verified-functions'), {
  basePath: process.cwd(), archiveFormat: 'none',
  config: { '*': { nodeBundler: 'esbuild', nodeVersion: '24', externalNodeModules: ['pg'],
    includedFiles: ['app/*.cjs', 'app/public/**', 'lib/*.mjs'] } }
});
console.log(result.map(({ name, path, runtime }) => ({ name, path, runtime })));
