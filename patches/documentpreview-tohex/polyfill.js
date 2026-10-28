/* task-121: Uint8Array toHex/toBase64 polyfill for Windows Chrome before PDF.js fingerprints */
;(function () {
  var proto = typeof Uint8Array === 'function' ? Uint8Array.prototype : null
  if (proto === null) return

  function define(name, value) {
    if (typeof proto[name] === 'function') return
    try {
      Object.defineProperty(proto, name, {
        value: value,
        configurable: true,
        writable: true,
        enumerable: false,
      })
    } catch (_) {
      // A frozen prototype is not repairable here; leave it for the caller to report.
    }
  }

  define('toHex', function toHex() {
    var out = ''
    for (var i = 0; i < this.length; i += 1) {
      out += this[i].toString(16).padStart(2, '0')
    }
    return out
  })

  define('toBase64', function toBase64(options) {
    var alphabet = options && options.alphabet === 'base64url'
      ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
      : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    var omitPadding = !!(options && options.omitPadding)
    var out = ''
    for (var i = 0; i < this.length; i += 3) {
      var a = this[i]
      var b = i + 1 < this.length ? this[i + 1] : 0
      var c = i + 2 < this.length ? this[i + 2] : 0
      var triplet = (a << 16) | (b << 8) | c
      out += alphabet[(triplet >> 18) & 63]
      out += alphabet[(triplet >> 12) & 63]
      out += i + 1 < this.length ? alphabet[(triplet >> 6) & 63] : (omitPadding ? '' : '=')
      out += i + 2 < this.length ? alphabet[triplet & 63] : (omitPadding ? '' : '=')
    }
    return out
  })
})()
