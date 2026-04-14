export type AppVariables = {
  userId: string;
  userRole: 'admin' | 'user';
};

export type AppEnv = {
  Variables: AppVariables;
};

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
