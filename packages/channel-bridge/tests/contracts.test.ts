import { messageStoreContract, wakeQueueContract, outboxStoreContract, jobIdsContract } from './contracts/store-contracts'
import { MemoryJobIds } from '../src/adapters/memory/memory-job-ids'
import { SqliteJobIds } from '../src/adapters/sqlite/sqlite-job-ids'
import { MemoryMessageStore } from '../src/adapters/memory/memory-message-store'
import { MemoryWakeQueue } from '../src/adapters/memory/memory-wake-queue'
import { MemoryOutboxStore } from '../src/adapters/memory/memory-outbox-store'
import { openBridgeDatabase } from '../src/adapters/sqlite/bridge-database'
import { SqliteMessageStore } from '../src/adapters/sqlite/sqlite-message-store'
import { SqliteWakeQueue } from '../src/adapters/sqlite/sqlite-wake-queue'
import { SqliteOutboxStore } from '../src/adapters/sqlite/sqlite-outbox-store'

messageStoreContract('memory', () => new MemoryMessageStore())
messageStoreContract('sqlite', () => new SqliteMessageStore(openBridgeDatabase(':memory:')))
wakeQueueContract('memory', () => new MemoryWakeQueue())
wakeQueueContract('sqlite', () => new SqliteWakeQueue(openBridgeDatabase(':memory:')))
outboxStoreContract('memory', () => new MemoryOutboxStore())
outboxStoreContract('sqlite', () => new SqliteOutboxStore(openBridgeDatabase(':memory:')))
jobIdsContract('memory', () => {
  const [store, wakes, outbox] = [new MemoryMessageStore(), new MemoryWakeQueue(), new MemoryOutboxStore()]
  return { ids: new MemoryJobIds(store, wakes, outbox), store, wakes, outbox }
})
jobIdsContract('sqlite', () => {
  const db = openBridgeDatabase(':memory:')
  return { ids: new SqliteJobIds(db), store: new SqliteMessageStore(db), wakes: new SqliteWakeQueue(db), outbox: new SqliteOutboxStore(db) }
})
