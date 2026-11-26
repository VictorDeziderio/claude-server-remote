// Files dropped, pasted or picked on the terminal page: each one is uploaded to the server, then the
// absolute paths are typed into the terminal, which is how Claude Code attaches an image (the same
// thing a desktop terminal does when an image is dragged onto it).

// POSIX shell quoting, only when needed (paths made by the server are plain, but stay safe)
export const shellQuote = (p) => (/^[\w./@%+=:,-]+$/.test(p) ? p : "'" + String(p).replace(/'/g, "'\\''") + "'")

// the text typed into the terminal for the uploaded paths (a trailing space, ready for more words)
export const pathsLine = (paths) => (paths.length ? paths.map(shellQuote).join(' ') + ' ' : '')

// the files carried by a drop or paste event (empty when it only carries text)
export const filesOf = (dt) => Array.from(dt?.files || []).filter((f) => f && f.size >= 0)
