import { safeHandle } from '../../lib/handler.js';

export default (req) => safeHandle(req);

export const config = { path: '/api/*' };
