// Writer operation registry. Only names listed here can run inside the Writer.
import { reserve, completeDemo } from './bookings.mjs';
import { handleWebhook } from './webhooks.mjs';
import { claimCode } from './codes.mjs';
import { requestReset, resetPassword } from './password-reset.mjs';
import { createPt, createBlock, updateBlock, markAttendance } from './manage.mjs';

export const ops = { reserve, completeDemo, handleWebhook, claimCode, requestReset, resetPassword, createPt, createBlock, updateBlock, markAttendance };
