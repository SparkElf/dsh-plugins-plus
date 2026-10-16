/**
 * The one official slot this plugin shadows, declared structurally.
 *
 * `conversation.chat.node` belongs to `@deepseek-ai/dsh-client-ui-chat`, which this package
 * does not depend on: the plugin is loaded into a deployment the operator composes, so
 * pinning a peer on one official UI package would tie the plugin to that package's version
 * and make a profile that ships a different one fail to activate. The declaration below
 * mirrors the official one (`dsh-client-ui-chat/lib/types/client/contract/slots.d.ts:306`)
 * for the parts this plugin actually uses.
 *
 * Declaration merging is what makes `ctx.slots.register({name: 'conversation.chat.node'})`
 * type-check without that dependency, and — because the merged interface only ever *adds*
 * members — a deployment that has the official declaration loaded still resolves the real,
 * fully typed one. The two agree on every field named here.
 *
 * @module @sparkelf/dsh-group-chat/client/contract
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Final Chat node renderer, keyed by node kind.
     *
     * The official declaration says: "Reusing a key replaces that node renderer". That is
     * this plugin's whole reason for touching the slot — the `user` cell is where a room's
     * message placement is decided, and the official renderer has no notion of more than one
     * author.
     */
    'conversation.chat.node': {
      kind: 'keyed'
      scope: 'session'
      owner: {
        /** The Chat node this row renders; `data` is the message the session log carries. */
        readonly node: { readonly data: unknown }
        readonly [key: string]: unknown
      }
      keyProps: {
        readonly user: { readonly node: { readonly data: unknown } }
        readonly [kind: string]: { readonly node: { readonly data: unknown } }
      }
      hookContext: unknown
      inject: unknown
    }
  }

  interface LocaleNamespaceMap {
    /**
     * Chat's own namespace, declared so this plugin's registration can name it.
     *
     * The seat synthesizes a component's `t` prop from the namespace its *registration*
     * declares, and the official bubble looks up `chat` keys such as `message.referenceSummary`
     * and `copy`. Registering without a namespace would leave the bubble translating against
     * nothing and printing raw keys, so the official namespace has to be named here.
     *
     * The value type is deliberately `string`: it is the shape of the dictionary, and this
     * plugin neither reads nor owns those keys — only the shell's own ui-chat registration
     * does, and it brings the real, fully typed augmentation with it. Declaring the *keys*
     * here would mean copying a dictionary this package does not ship and cannot keep in
     * step. Losing the per-key literal type is the honest cost of not depending on that
     * package; what matters for correctness is that `chat` is a known namespace name.
     */
    chat: string
  }
}

export {}
