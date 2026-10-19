import { jest } from '@jest/globals'
import { createRequire } from 'node:module'
import { toStroops, createVaultArgs, stakeArgs, buildCreateVaultTx, verifySignedTx, submitAndWait, decodeContractError, OnchainError } from '../soroban.mjs'

const sdk = createRequire(import.meta.url)('@stellar/stellar-sdk')
const { Keypair, Account, Contract, TransactionBuilder, StrKey, scValToNative, xdr } = sdk

const PASS = 'Test SDF Network ; September 2015'
const creatorKp = Keypair.random()
const cfg = {
  networkPassphrase: PASS,
  contractId: StrKey.encodeContract(Buffer.alloc(32, 1)),
  tokenId: StrKey.encodeContract(Buffer.alloc(32, 2)),
}
const vault = {
  id: 'vault-abc123', creator: creatorKp.publicKey(), verifier: Keypair.random().publicKey(),
  successDestination: creatorKp.publicKey(), failureDestination: Keypair.random().publicKey(),
  amount: '1.5', endDate: '2030-01-01T00:00:00.000Z',
  milestones: [
    { title: 'one', amount: '1', dueDate: '2029-06-01T00:00:00.000Z' },
    { title: 'two', amount: '0.5', dueDate: '2029-12-01T00:00:00.000Z' },
  ],
}

const signedTx = (op, args, { contractId = cfg.contractId, signer = creatorKp, source = vault.creator, pass = PASS } = {}) => {
  const tx = new TransactionBuilder(new Account(source, '1'), { fee: '100', networkPassphrase: pass })
    .addOperation(new Contract(contractId).call(op, ...args)).setTimeout(300).build()
  tx.sign(signer)
  return tx.toXDR()
}

describe('toStroops', () => {
  it('converts exactly with BigInt', () => {
    expect(toStroops('1.5')).toBe(15_000_000n)
    expect(toStroops('0.0000001')).toBe(1n)
    expect(toStroops('999999999999.1234567')).toBe(9999999999991234567n)
  })
  it('rejects non-exact input', () => {
    expect(() => toStroops('0.12345678')).toThrow(OnchainError)
    expect(() => toStroops('1e-7')).toThrow(OnchainError)
    expect(() => toStroops('-1')).toThrow(OnchainError)
  })
})

describe('create_vault arg encoding', () => {
  it('encodes stroops i128, u64 seconds, verifier set, oracle None and milestone vec', () => {
    const a = createVaultArgs(vault, cfg.tokenId)
    expect(a).toHaveLength(10)
    expect(scValToNative(a[0])).toBe(vault.id)
    expect(a[1].switch().name).toBe('scvAddress')
    const set = scValToNative(a[2])
    expect(set.threshold).toBe(1)
    expect(set.verifiers).toEqual([vault.verifier])
    expect(a[3].switch().name).toBe('scvVoid')
    expect(a[5].switch().name).toBe('scvI128')
    expect(scValToNative(a[5])).toBe(15_000_000n)
    expect(a[8].switch().name).toBe('scvU64')
    expect(scValToNative(a[8])).toBe(BigInt(Date.parse(vault.endDate) / 1000))
    const ms = scValToNative(a[9])
    expect(ms.map((m) => m.amount)).toEqual([10_000_000n, 5_000_000n])
    expect(ms[0]).toMatchObject({ title: 'one', verified: false, released: false, due_date: BigInt(Date.parse(vault.milestones[0].dueDate) / 1000) })
  })
  it('rejects milestones that do not sum to the vault amount', () => {
    expect(() => createVaultArgs({ ...vault, amount: '2' }, cfg.tokenId)).toThrow(/add up/)
  })
  it('builds an unsigned tx through the (mocked) rpc server', async () => {
    const server = { getAccount: jest.fn(async (k) => new Account(k, '1')), prepareTransaction: jest.fn(async (t) => t) }
    const out = await buildCreateVaultTx(server, cfg, vault)
    expect(out.networkPassphrase).toBe(PASS)
    const tx = TransactionBuilder.fromXDR(out.xdr, PASS)
    expect(tx.operations[0].func.invokeContract().functionName().toString()).toBe('create_vault')
  })
  it('maps simulation contract errors to a 400', async () => {
    const server = { getAccount: async (k) => new Account(k, '1'), prepareTransaction: async () => { throw new Error('HostError: Error(Contract, #16)') } }
    await expect(buildCreateVaultTx(server, cfg, vault)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('AmountMismatch') })
  })
})

describe('verifySignedTx', () => {
  const good = () => signedTx('create_vault', createVaultArgs(vault, cfg.tokenId))
  it('accepts the exact invocation and returns its hash', () => {
    const { hash } = verifySignedTx(good(), vault, 'create_vault', cfg)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('accepts stake', () => {
    expect(() => verifySignedTx(signedTx('stake', stakeArgs(vault)), vault, 'stake', cfg)).not.toThrow()
  })
  it('rejects a different contract', () => {
    const x = signedTx('create_vault', createVaultArgs(vault, cfg.tokenId), { contractId: StrKey.encodeContract(Buffer.alloc(32, 9)) })
    expect(() => verifySignedTx(x, vault, 'create_vault', cfg)).toThrow(/different contract/)
  })
  it('rejects a different function', () => {
    expect(() => verifySignedTx(signedTx('stake', stakeArgs(vault)), vault, 'create_vault', cfg)).toThrow(/must call create_vault/)
  })
  it('rejects different args', () => {
    const x = signedTx('create_vault', createVaultArgs({ ...vault, id: 'vault-other' }, cfg.tokenId))
    expect(() => verifySignedTx(x, vault, 'create_vault', cfg)).toThrow(/do not match/)
  })
  it('rejects a foreign source or signer', () => {
    const other = Keypair.random()
    const x = signedTx('create_vault', createVaultArgs(vault, cfg.tokenId), { signer: other, source: other.publicKey() })
    expect(() => verifySignedTx(x, vault, 'create_vault', cfg)).toThrow(/source must be the vault creator/)
    const y = signedTx('create_vault', createVaultArgs(vault, cfg.tokenId), { signer: other })
    expect(() => verifySignedTx(y, vault, 'create_vault', cfg)).toThrow(/signature/)
  })
  it('rejects a network passphrase mismatch', () => {
    const x = signedTx('create_vault', createVaultArgs(vault, cfg.tokenId), { pass: 'Public Global Stellar Network ; September 2015' })
    expect(() => verifySignedTx(x, vault, 'create_vault', cfg)).toThrow(/signature/)
  })
  it('rejects garbage', () => {
    expect(() => verifySignedTx('not-xdr', vault, 'create_vault', cfg)).toThrow(OnchainError)
  })
})

describe('result decoding and polling', () => {
  const errEvent = (code) => ({
    event: () => ({ body: () => ({ v0: () => ({ topics: () => [xdr.ScVal.scvSymbol('error')], data: () => xdr.ScVal.scvError(xdr.ScError.sceContract(code)) }) }) }),
  })
  it('decodes the contract error name from diagnostic events', () => {
    expect(decodeContractError([errEvent(16)])).toMatchObject({ code: 16, name: 'AmountMismatch' })
    expect(decodeContractError([])).toBeNull()
  })

  const tx = { id: 'tx' }
  const hash = 'ab'.repeat(32)
  it('returns SUCCESS with the ledger', async () => {
    const server = { sendTransaction: jest.fn(async () => ({ status: 'PENDING', hash })), getTransaction: jest.fn().mockResolvedValueOnce({ status: 'NOT_FOUND' }).mockResolvedValueOnce({ status: 'SUCCESS', ledger: 777 }) }
    await expect(submitAndWait(server, tx, hash, { intervalMs: 1 })).resolves.toEqual({ status: 'SUCCESS', hash, ledger: 777 })
  })
  it('returns FAILED with the decoded error name', async () => {
    const server = { sendTransaction: async () => ({ status: 'PENDING', hash }), getTransaction: async () => ({ status: 'FAILED', ledger: 5, diagnosticEventsXdr: [errEvent(16)] }) }
    const r = await submitAndWait(server, tx, hash, { intervalMs: 1 })
    expect(r.status).toBe('FAILED')
    expect(r.error.name).toBe('AmountMismatch')
  })
  it('stays PENDING when polling times out', async () => {
    const server = { sendTransaction: async () => ({ status: 'PENDING', hash }), getTransaction: async () => ({ status: 'NOT_FOUND' }) }
    await expect(submitAndWait(server, tx, hash, { timeoutMs: 20, intervalMs: 5 })).resolves.toEqual({ status: 'PENDING', hash })
  })
  it('resume checks the chain first and does not re-broadcast', async () => {
    const server = { sendTransaction: jest.fn(), getTransaction: async () => ({ status: 'SUCCESS', ledger: 9 }) }
    const r = await submitAndWait(server, tx, hash, { resume: true })
    expect(r.status).toBe('SUCCESS')
    expect(server.sendTransaction).not.toHaveBeenCalled()
  })
  it('tolerates RPC errors while polling', async () => {
    const server = { sendTransaction: async () => ({ status: 'PENDING', hash }), getTransaction: async () => { throw new Error('rpc down') } }
    await expect(submitAndWait(server, tx, hash, { timeoutMs: 20, intervalMs: 5 })).resolves.toMatchObject({ status: 'PENDING' })
  })
})
