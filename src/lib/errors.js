export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (code, msg, extra) => new HttpError(400, code, msg, extra);
export const forbidden = (code, msg, extra) => new HttpError(403, code, msg, extra);
export const notFound = (msg = 'Not found') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (code, msg, extra) => new HttpError(409, code, msg, extra);
