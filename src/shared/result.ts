export interface Result<T> {
  success: boolean;
  data?: T;
  error?: string;
  errors: string[];
}

function ok<T>(data: T): Result<T> {
  return { success: true, data, errors: [] };
}

function fail<T>(error: string, ...errors: string[]): Result<T> {
  return { success: false, error, errors: errors.length > 0 ? errors : [error] };
}

function failWithErrors<T>(errors: string[]): Result<T> {
  return { success: false, error: errors[0], errors };
}
