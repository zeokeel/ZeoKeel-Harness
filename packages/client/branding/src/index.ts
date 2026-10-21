/**
 * Host plugin for `@zeokeel/dsh-branding`: the node half is a no-op — all
 * brand surfaces live in the client half (`./client`), which registers the
 * brace mark at the upstream brand slots and swaps the favicon.
 * @module @zeokeel/dsh-branding
 */

export const name = 'dsh-branding'

export function apply(): void {}
