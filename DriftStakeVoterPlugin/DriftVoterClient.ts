import { BN, Program, Provider } from '@coral-xyz/anchor'
import { Client } from '@solana/governance-program-library'
import { SYSTEM_PROGRAM_ID } from '@solana/spl-governance'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { DriftStakeVoter, IDL } from './idl/driftStakeVoter'
import { IDL as DriftIDL } from './idl/drift'
import {
  getInsuranceFundStakeAccountPublicKey,
  getInsuranceFundVaultPublicKey,
  getSpotMarketPublicKey,
  unstakeSharesToAmountWithOpenRequest,
} from './driftSdk'
import { fetchTokenAccountByPubkey } from '@hooks/queries/tokenAccount'
import { DRIFT_STAKE_VOTER_PLUGIN } from './constants'
import { fetchRealmByPubkey } from '@hooks/queries/realm'

export class DriftVoterClient extends Client<DriftStakeVoter> {
  readonly requiresInputVoterWeight = false

  constructor(
    public program: Program<DriftStakeVoter>,
    public devnet: boolean
  ) {
    super(program, devnet)
  }

  async calculateMaxVoterWeight(
    _realm: PublicKey,
    _mint: PublicKey
  ): Promise<BN | null> {
    console.log(
      'drift voter client was just asked to calculate max voter weight'
    )
    const { result: realm } = await fetchRealmByPubkey(
      this.program.provider.connection,
      _realm
    )
    console.log('drift voter client realm', realm)
    return realm?.account.config?.communityMintMaxVoteWeightSource.value ?? null // TODO this code should not actually be called because this is not a max voter weight plugin
  }

  async calculateVoterWeight(
    voter: PublicKey,
    realm: PublicKey,
    mint: PublicKey
  ): Promise<BN | null> {
    console.log('drift voter clint', 1)

    const { registrar: registrarPk } = this.getRegistrarPDA(realm, mint)
    const registrar = await this.program.account.registrar.fetch(registrarPk)
    const spotMarketIndex = registrar.spotMarketIndex // could just hardcode spotmarket pk
    const driftProgramId = registrar.driftProgramId // likewise
    const drift = new Program(DriftIDL, driftProgramId, this.program.provider)
    const spotMarketPk = await getSpotMarketPublicKey(
      driftProgramId,
      spotMarketIndex
    )
    const insuranceFundVaultPk = await getInsuranceFundVaultPublicKey(
      driftProgramId,
      spotMarketIndex
    )
    const insuranceFundStakePk = await getInsuranceFundStakeAccountPublicKey(
      driftProgramId,
      voter,
      spotMarketIndex
    )

    const spotMarket = await drift.account.spotMarket.fetch(spotMarketPk)

    let insuranceFundStake: Awaited<
      ReturnType<typeof drift.account.insuranceFundStake.fetch>
    >
    try {
      insuranceFundStake = await drift.account.insuranceFundStake.fetch(
        insuranceFundStakePk
      )
    } catch (e) {
      console.log('drift voter client', 'no insurance fund stake account found')
      return new BN(0)
    }
    console.log('drift voter clint', 2)

    const insuranceFundVault = await fetchTokenAccountByPubkey(
      this.program.provider.connection,
      insuranceFundVaultPk
    )
    if (insuranceFundVault.result === undefined)
      throw new Error(
        'Insurance fund vault not found: ' + insuranceFundVaultPk.toString()
      )

    const nShares = insuranceFundStake.ifShares
    const withdrawRequestShares = insuranceFundStake.lastWithdrawRequestShares
    const withdrawRequestAmount = insuranceFundStake.lastWithdrawRequestValue
    const totalIfShares = spotMarket.insuranceFund.totalShares
    const insuranceFundVaultBalance = insuranceFundVault.result?.amount

    const amount = unstakeSharesToAmountWithOpenRequest(
      nShares,
      withdrawRequestShares,
      withdrawRequestAmount,
      totalIfShares,
      insuranceFundVaultBalance
    )
    console.log('drift voter clint', 3)
    console.log('drift voter clint amount', amount.toString())

    return amount
  }

  async updateVoterWeightRecord(
    voter: PublicKey,
    realm: PublicKey,
    mint: PublicKey
    //action?: VoterWeightAction | undefined,
    //inputRecordCallback?: (() => Promise<PublicKey>) | undefined
  ): Promise<{
    pre: TransactionInstruction[]
    post?: TransactionInstruction[] | undefined
  }> {
    const { voterWeightPk } = this.getVoterWeightRecordPDA(realm, mint, voter)
    const { registrar: registrarPk } = this.getRegistrarPDA(realm, mint)
    const registrar = await this.program.account.registrar.fetch(registrarPk)
    const spotMarketIndex = registrar.spotMarketIndex // could just hardcode spotmarket pk
    const driftProgramId = registrar.driftProgramId // likewise
    //const drift = new Program(DriftIDL, driftProgramId, this.program.provider)
    const spotMarketPk = await getSpotMarketPublicKey(
      driftProgramId,
      spotMarketIndex
    )
    const insuranceFundVaultPk = await getInsuranceFundVaultPublicKey(
      driftProgramId,
      spotMarketIndex
    )
    const insuranceFundStakePk = await getInsuranceFundStakeAccountPublicKey(
      driftProgramId,
      voter,
      spotMarketIndex
    )

    const ix = await this.program.methods
      .updateVoterWeightRecord()
      .accounts({
        voterWeightRecord: voterWeightPk,
        registrar: registrarPk,
        driftProgram: driftProgramId,
        spotMarket: spotMarketPk,
        insuranceFundStake: insuranceFundStakePk,
        insuranceFundVault: insuranceFundVaultPk,
      })
      .instruction()

    return { pre: [ix] }
  }

  // NO-OP
  async createMaxVoterWeightRecord(): Promise<TransactionInstruction | null> {
    return null
  }

  // NO-OP
  async updateMaxVoterWeightRecord(): Promise<TransactionInstruction | null> {
    return null
  }

  static async connect(
    provider: Provider,
    programId = new PublicKey(DRIFT_STAKE_VOTER_PLUGIN),
    devnet = false
  ): Promise<DriftVoterClient> {
    return new DriftVoterClient(
      new Program<DriftStakeVoter>(IDL, programId, provider),
      devnet
    )
  }

  async createVoterWeightRecord(
    voter: PublicKey,
    realm: PublicKey,
    mint: PublicKey
  ): Promise<TransactionInstruction | null> {
    const { voterWeightPk } = this.getVoterWeightRecordPDA(realm, mint, voter)
    const { registrar } = this.getRegistrarPDA(realm, mint)

    return this.program.methods
      .createVoterWeightRecord(voter)
      .accounts({
        voterWeightRecord: voterWeightPk,
        registrar,
        payer: voter,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .instruction()
  }
}
