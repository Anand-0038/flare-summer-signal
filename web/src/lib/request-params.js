const REQUEST_URL_BASE = 'https://flare-summer-signal.invalid'

export function parseSearchParams(requestUrl) {
  try {
    const url = new URL(requestUrl || '/', REQUEST_URL_BASE)
    return url.searchParams
  } catch {
    return null
  }
}

export function parseSearchParamsOrErrorResponse(request, response) {
  const searchParams = parseSearchParams(request?.url)
  if (!searchParams) {
    response.status(400).json({
      error: 'INVALID_REQUEST_URL',
      message: 'The request URL could not be parsed. Retry with a valid, encoded request.',
    })
    return null
  }

  return searchParams
}
