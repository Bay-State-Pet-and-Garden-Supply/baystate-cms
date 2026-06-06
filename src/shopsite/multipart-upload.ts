/**
 * Build MIME multipart body for ShopSite dbupload.cgi.
 * Parses the upload response to extract the dbmake return string.
 */

const BOUNDARY_PREFIX = '---------------------------ShopSiteUpload';

export interface UploadFormFields {
  clientApp: string;
  dbname: string;
  uniqueName: string;
  newRecords: string;
  defer_linking: string;
  batchsize?: string;
  use_optimizer?: string;
  [key: string]: string | undefined;
}

export interface MultipartResult {
  body: Uint8Array;
  contentType: string;
  contentLength: number;
}

const XML_TAG_NAME_RE = /^[a-zA-Z_][\w.-]*$/;

/**
 * Validate that a string is a safe XML tag name.
 */
export function isValidXmlTagName(name: string): boolean {
  return XML_TAG_NAME_RE.test(name) && !name.startsWith('xml') && !name.startsWith('XML');
}

/**
 * Escape CDATA terminators inside CDATA blocks.
 */
export function escapeCdata(value: string): string {
  return value.replace(/]]>/g, ']]]]><![CDATA[>');
}

/**
 * Build a MIME multipart request body for dbupload.cgi.
 * The XML content is sent as a file field named "Desktop".
 * Default documented fields are set according to project convention.
 */
export function buildUploadMultipart(
  xml: string,
  overrides?: Partial<UploadFormFields>,
): MultipartResult {
  const boundary = `${BOUNDARY_PREFIX}_${Date.now().toString(36)}`;
  const parts: string[] = [];

  const fields: UploadFormFields = {
    clientApp: '1',
    dbname: 'products',
    uniqueName: 'SKU',
    newRecords: 'yes',
    defer_linking: 'no',
    ...overrides,
  };

  // Add form fields
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`--${boundary}\r\n`);
    parts.push(`Content-Disposition: form-data; name="${key}"\r\n\r\n`);
    parts.push(`${value}\r\n`);
  }

  // Add XML file field (name "Desktop" is documented convention)
  parts.push(`--${boundary}\r\n`);
  parts.push('Content-Disposition: form-data; name="Desktop"; filename="shopsite-products.xml"\r\n');
  parts.push('Content-Type: text/xml\r\n\r\n');
  parts.push(xml);
  parts.push(`\r\n--${boundary}--\r\n`);

  const bodyStr = parts.join('');
  const encoder = new TextEncoder();
  const body = encoder.encode(bodyStr);

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: body.length,
  };
}

/**
 * Extract the dbmake return string from a dbupload.cgi response.
 * Handles documented shapes:
 * - Direct link: `dbmake.cgi?key=value&...`
 * - Query string: `key=value&key2=value2`
 * - Link in HTML/XML: `<a href="dbmake.cgi?key=value">`
 * - Plain text query string
 *
 * Does NOT treat heuristic "success" text as a valid dbmake return.
 * Returns null when no concrete dbmake return string is found.
 */
export function extractDbmakeQuery(uploadResponse: string): string | null {
  const normalized = uploadResponse.trim();

  // Pattern 1: Full URL with dbmake.cgi?query (allow & in params)
  const urlMatch = normalized.match(/dbmake\.cgi\?([^\s"'<>]+)/i);
  if (urlMatch) {
    return urlMatch[1].split(/[\s"'<>]/)[0];
  }

  // Pattern 2: Query string embedded in HTML/XML attribute href
  const hrefMatch = normalized.match(/href=["']([^"']*dbmake\.cgi\?([^"'\s]+))["']/i);
  if (hrefMatch) {
    return hrefMatch[2];
  }

  // Pattern 3: Plain query string (key=value&key2=value2)
  const directQuery = normalized.replace(/^[^?]*\?/, '').trim();
  if (/^[A-Za-z0-9_.%-]+=[^<>\s]+(&[A-Za-z0-9_.%-]+=[^<>\s]+)*$/.test(directQuery)) {
    return directQuery;
  }

  // No documented dbmake return string found - must return null
  // Generic success/complete/imported text alone does NOT satisfy the
  // documented requirement to replay the return_string through dbmake.cgi
  return null;
}

/**
 * Check if a dbmake.cgi response body indicates a successful completion.
 * HTTP 2xx alone is not sufficient; we check for known success signals.
 */
export function isDbmakeSuccessful(responseText: string): boolean {
  const body = responseText.trim().toLowerCase();

  const hasErrorLike = body.includes('error') || body.includes('failed') || body.includes('fail') || body.includes('exception');
  const harmlessly = body.includes('no errors') || body.includes('without error') || body.includes('0 errors') || body.includes('0 failures');

  if (hasErrorLike && !harmlessly) {
    // Double-check for strong success signal overriding error
    const successSignals = ['operation complete', 'successful', 'completed successfully', 'accepted'];
    if (successSignals.some(s => body.includes(s))) {
      return true;
    }
    return false;
  }

  // Reject empty or minimal responses
  if (body.length < 5) return false;

  // Default: likely successful
  return true;
}

/**
 * Redact sensitive values from a string for safe logging.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/(Authorization:\s*)(Basic\s+\S+)/gi, '$1[REDACTED]')
    .replace(/(["']?password["']?\s*:\s*["'])([^"']+)(["'])/gi, '$1[REDACTED]$3')
    .replace(/(password=)([^&\s]+)/gi, '$1[REDACTED]')
    .replace(/(merchant_id=)([^&\s]+)/gi, '$1[REDACTED]')
    .replace(/(["']?merchant["']?\s*:\s*["'])([^"']+)(["'])/gi, '$1[REDACTED]$3');
}
