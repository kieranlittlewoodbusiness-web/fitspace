// Writer operation registry. Only names listed here can run inside the Writer.
import { reserve } from './bookings.mjs';
import { handleWebhook } from './webhooks.mjs';
import { claimCode } from './codes.mjs';

export const ops = { reserve, handleWebhook, claimCode };
