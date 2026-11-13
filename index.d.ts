export type EventType = 'create' | 'update' | 'delete'
export interface Event { path: string; type: EventType }
export interface Options { ignore?: string[]; backend?: 'inotify' | 'brute-force' }
export type SubscribeCallback = (error: Error | null, events: Event[]) => unknown
export interface AsyncSubscription { unsubscribe(): Promise<void> }
export function subscribe(dir: string, callback: SubscribeCallback, options?: Options): Promise<AsyncSubscription>
export function unsubscribe(dir: string, callback: SubscribeCallback, options?: Options): Promise<void>
export function writeSnapshot(dir: string, file: string, options?: Options): Promise<void>
export function getEventsSince(dir: string, file: string, options?: Options): Promise<Event[]>
