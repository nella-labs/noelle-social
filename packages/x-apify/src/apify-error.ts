export class ApifyXError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApifyXError";
    this.status = status;
  }
}
