/** The places of the cards and the boxes of the code graph. `routed.ts`
 * makes them. */

export interface Placed {
  x: number
  y: number
  width: number
  height: number
}

export interface Layout {
  at: Map<string, Placed>
  width: number
  height: number
}

export interface RealmBox<R extends string> {
  realm: R
  x: number
  y: number
  width: number
  height: number
}

/** A group of cards inside a realm, for example the entity that the code runs in. */
export interface GroupBox<R extends string> extends RealmBox<R> {
  group: string
  /** 0: a group of the realm. 1 and more: a box inside a group, from `path`. */
  level: number
}

export interface RealmLayout<R extends string> extends Layout {
  realms: RealmBox<R>[]
  groups: GroupBox<R>[]
}
