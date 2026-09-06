export const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production'
  ? (() => { throw new Error('JWT_SECRET is required when NODE_ENV=production') })()
  : 'dev-secret-change-me');
