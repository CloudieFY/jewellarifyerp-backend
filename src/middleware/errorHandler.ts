import { Request, Response, NextFunction } from 'express';
import cors from 'cors';

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
};

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // In development, allow all origins (native apps, web dev servers, etc.)
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }

    // In production, check against allowed origins
    const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim());

    // allow non-browser tools (curl/postman) with no origin header
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Disallowed origin: respond WITHOUT CORS headers (the browser then blocks
    // the response client-side). Do NOT pass an Error here — that turns every
    // cross-origin probe into a 500 + a logged stack trace.
    callback(null, false);
  },
  credentials: true,
});
