// 统一收集浏览器和网络异常；调用方保留业务断言及场景特有噪声判定。
export function observePage(page, label, problems) {
  const requests = { pending: new Set(), settingsJoinCount: 0 }
  page.on('request', request => {
    requests.pending.add(request)
    if (/\/api\/(?:settings|credentials|llm)\./.test(new URL(request.url()).pathname)) requests.settingsJoinCount += 1
  })
  page.on('requestfinished', request => { requests.pending.delete(request) })
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const location = message.location()
      const source = location.url === '' ? '' : ' at ' + location.url + ':' + location.lineNumber + ':' + location.columnNumber
      problems.push(label + ' console ' + message.type() + ': ' + message.text() + source)
    }
  })
  page.on('pageerror', error => { problems.push(label + ' pageerror: ' + (error.stack ?? error.message)) })
  page.on('requestfailed', request => {
    requests.pending.delete(request)
    problems.push(label + ' requestfailed: ' + request.url() + ' ' + (request.failure()?.errorText ?? 'failed'))
  })
  page.on('response', response => {
    if (response.status() >= 500) problems.push(label + ' HTTP ' + response.status() + ': ' + response.url())
  })
  return requests
}
