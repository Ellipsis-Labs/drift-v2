import * as anchor from '@project-serum/anchor';
import {
	BASE_PRECISION,
	BN,
	getLimitOrderParams,
	isVariant,
	OracleSource,
	QUOTE_PRECISION,
	ZERO,
	OracleGuardRails,
	ContractTier,
	TestClient,
	EventSubscriber,
	PRICE_PRECISION,
	PositionDirection,
	Wallet,
	LIQUIDATION_PCT_PRECISION,
	User,
} from '../sdk/src';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	printTxLogs,
	sleep,
} from './testHelpers';
import { BulkAccountLoader } from '../sdk';

describe('liquidate perp and lp', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;
	const eventSubscriber = new EventSubscriber(connection, chProgram, {
		commitment: 'recent',
	});
	eventSubscriber.subscribe();

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	let usdcMint;
	let userUSDCAccount;

	const liquidatorKeyPair = new Keypair();
	let liquidatorUSDCAccount: Keypair;
	let liquidatorDriftClient: TestClient;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);
	const nLpShares = new BN(10000000);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		const oracle = await mockOracle(1);

		driftClient = new TestClient({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await driftClient.updateInitialPctToLiquidate(
			LIQUIDATION_PCT_PRECISION.toNumber()
		);

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
		await driftClient.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await driftClient.initializePerpMarket(
			oracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await driftClient.openPosition(
			PositionDirection.LONG,
			new BN(175).mul(BASE_PRECISION).div(new BN(10)), // 25 SOL
			0,
			new BN(0)
		);

		const txSig = await driftClient.addPerpLpShares(nLpShares, 0);
		await printTxLogs(connection, txSig);

		for (let i = 0; i < 32; i++) {
			await driftClient.placePerpOrder(
				getLimitOrderParams({
					baseAssetAmount: BASE_PRECISION,
					marketIndex: 0,
					direction: PositionDirection.LONG,
					price: PRICE_PRECISION,
				})
			);
		}

		provider.connection.requestAirdrop(liquidatorKeyPair.publicKey, 10 ** 9);
		liquidatorUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			liquidatorKeyPair.publicKey
		);
		liquidatorDriftClient = new TestClient({
			connection,
			wallet: new Wallet(liquidatorKeyPair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0],
			oracleInfos: [
				{
					publicKey: oracle,
					source: OracleSource.PYTH,
				},
			],
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});
		await liquidatorDriftClient.subscribe();

		await liquidatorDriftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			liquidatorUSDCAccount.publicKey
		);
	});

	after(async () => {
		await driftClient.unsubscribe();
		await liquidatorDriftClient.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('liquidate', async () => {
		const marketIndex = 0;
		const lpShares = driftClient.getUserAccount().perpPositions[0].lpShares;
		assert(lpShares.eq(nLpShares));

		const driftClientUser = new User({
			driftClient: driftClient,
			userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		});
		await driftClientUser.subscribe();

		const mtc = driftClientUser.getTotalCollateral('Maintenance');
		const mmr = driftClientUser.getMaintenanceMarginRequirement();
		const pp = driftClientUser.getPerpPosition(0);

		const deltaValueToLiq = mtc.sub(mmr); // QUOTE_PRECISION
		console.log('mtc:', mtc.toString());
		console.log('mmr:', mmr.toString());
		console.log('deltaValueToLiq:', deltaValueToLiq.toString());
		console.log('pp.base:', pp.baseAssetAmount.toString());

		const expectedLiqPrice = 0.566378;
		const liqPrice = driftClientUser.liquidationPrice(0, ZERO);
		console.log('liqPrice:', liqPrice.toString());
		assert(liqPrice.eq(new BN(expectedLiqPrice * PRICE_PRECISION.toNumber())));

		const oracle = driftClient.getPerpMarketAccount(0).amm.oracle;
		await setFeedPrice(anchor.workspace.Pyth, 0.9, oracle);
		await sleep(2000);
		await driftClientUser.fetchAccounts();
		await driftClient.fetchAccounts();

		const liqPriceAfterPxChange = driftClientUser.liquidationPrice(0, ZERO);
		const expectedLiqPriceAfterPxChange = 0.557026;

		console.log('liqPriceAfterPxChange:', liqPriceAfterPxChange.toString());
		const mtc0 = driftClientUser.getTotalCollateral('Maintenance');
		const mmr0 = driftClientUser.getMaintenanceMarginRequirement();
		const pp0 = driftClientUser.getPerpPosition(0);

		const deltaValueToLiq0 = mtc0.sub(mmr0); // QUOTE_PRECISION
		console.log('mtc0:', mtc0.toString());
		console.log('mmr0:', mmr0.toString());
		console.log('deltaValueToLiq0:', deltaValueToLiq0.toString());
		console.log('pp.base0:', pp0.baseAssetAmount.toString());
		assert(
			liqPriceAfterPxChange.eq(
				new BN(expectedLiqPriceAfterPxChange * PRICE_PRECISION.toNumber())
			)
		);

		await driftClient.settlePNL(
			driftClientUser.userAccountPublicKey,
			driftClientUser.getUserAccount(),
			0
		);
		await sleep(2000);
		await driftClientUser.fetchAccounts();
		await driftClient.fetchAccounts();

		const liqPriceAfterSettlePnl = driftClientUser.liquidationPrice(0, ZERO);

		const mtc2 = driftClientUser.getTotalCollateral('Maintenance');
		const mmr2 = driftClientUser.getMaintenanceMarginRequirement();
		const pp2 = driftClientUser.getPerpPosition(0);

		const deltaValueToLiq2 = mtc2.sub(mmr2); // QUOTE_PRECISION
		console.log('mtc2:', mtc2.toString());
		console.log('mmr2:', mmr2.toString());
		console.log('deltaValueToLiq2:', deltaValueToLiq2.toString());
		console.log('pp.base2:', pp2.baseAssetAmount.toString());

		console.log('liqPriceAfterSettlePnl:', liqPriceAfterSettlePnl.toString());
		assert(
			liqPriceAfterSettlePnl.eq(
				new BN(expectedLiqPriceAfterPxChange * PRICE_PRECISION.toNumber())
			)
		);

		await setFeedPrice(anchor.workspace.Pyth, 1.1, oracle);
		await driftClient.settlePNL(
			driftClientUser.userAccountPublicKey,
			driftClientUser.getUserAccount(),
			0
		);

		const liqPriceAfterRallySettlePnl = driftClientUser.liquidationPrice(
			0,
			ZERO
		);
		console.log(
			'liqPriceAfterRallySettlePnl:',
			liqPriceAfterRallySettlePnl.toString()
		);
		assert(
			liqPriceAfterRallySettlePnl.eq(
				new BN(0.575731 * PRICE_PRECISION.toNumber())
			)
		);
		await driftClientUser.unsubscribe();

		await setFeedPrice(anchor.workspace.Pyth, 0.1, oracle);

		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(1),
				markOracleDivergenceDenominator: new BN(10),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(11), // allow 11x change
			},
			useForLiquidations: false,
		};

		await driftClient.updateOracleGuardRails(oracleGuardRails);

		const txSig = await liquidatorDriftClient.liquidatePerp(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			new BN(175).mul(BASE_PRECISION).div(new BN(10))
		);

		await printTxLogs(connection, txSig);

		for (let i = 0; i < 32; i++) {
			assert(isVariant(driftClient.getUserAccount().orders[i].status, 'init'));
		}

		assert(
			liquidatorDriftClient
				.getUserAccount()
				.perpPositions[0].baseAssetAmount.eq(new BN(17500000000))
		);

		assert(isVariant(driftClient.getUserAccount().status, 'beingLiquidated'));
		assert(driftClient.getUserAccount().nextLiquidationId === 2);

		// try to add liq when being liquidated -- should fail
		try {
			await driftClient.addPerpLpShares(nLpShares, 0);
			assert(false);
		} catch (err) {
			assert(err.message.includes('0x17e5'));
		}

		const liquidationRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(liquidationRecord.liquidationId === 1);
		assert(isVariant(liquidationRecord.liquidationType, 'liquidatePerp'));
		assert(liquidationRecord.liquidatePerp.marketIndex === 0);
		assert(liquidationRecord.canceledOrderIds.length === 32);
		assert(
			liquidationRecord.liquidatePerp.oraclePrice.eq(
				PRICE_PRECISION.div(new BN(10))
			)
		);
		assert(
			liquidationRecord.liquidatePerp.baseAssetAmount.eq(new BN(-17500000000))
		);

		assert(
			liquidationRecord.liquidatePerp.quoteAssetAmount.eq(new BN(1750000))
		);
		assert(liquidationRecord.liquidatePerp.lpShares.eq(nLpShares));
		assert(liquidationRecord.liquidatePerp.ifFee.eq(new BN(17500)));
		assert(liquidationRecord.liquidatePerp.liquidatorFee.eq(new BN(0)));

		const fillRecord = eventSubscriber.getEventsArray('OrderActionRecord')[0];
		assert(isVariant(fillRecord.action, 'fill'));
		assert(fillRecord.marketIndex === 0);
		assert(isVariant(fillRecord.marketType, 'perp'));
		assert(fillRecord.baseAssetAmountFilled.eq(new BN(17500000000)));
		assert(fillRecord.quoteAssetAmountFilled.eq(new BN(1750000)));
		assert(fillRecord.takerOrderBaseAssetAmount.eq(new BN(17500000000)));
		assert(
			fillRecord.takerOrderCumulativeBaseAssetAmountFilled.eq(
				new BN(17500000000)
			)
		);
		assert(fillRecord.takerFee.eq(new BN(17500)));
		assert(isVariant(fillRecord.takerOrderDirection, 'short'));
		assert(fillRecord.makerOrderBaseAssetAmount.eq(new BN(17500000000)));
		assert(
			fillRecord.makerOrderCumulativeBaseAssetAmountFilled.eq(
				new BN(17500000000)
			)
		);
		console.log(fillRecord.makerFee.toString());
		assert(fillRecord.makerFee.eq(new BN(ZERO)));
		assert(isVariant(fillRecord.makerOrderDirection, 'long'));

		await liquidatorDriftClient.liquidatePerpPnlForDeposit(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0,
			0,
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount
		);

		await driftClient.fetchAccounts();
		assert(isVariant(driftClient.getUserAccount().status, 'bankrupt'));
		console.log(driftClient.getUserAccount().perpPositions[0].quoteAssetAmount);
		assert(
			driftClient
				.getUserAccount()
				.perpPositions[0].quoteAssetAmount.eq(new BN(-5785008))
		);

		// try to add liq when bankrupt -- should fail
		try {
			await driftClient.addPerpLpShares(nLpShares, 0);
			assert(false);
		} catch (err) {
			// cant add when bankrupt
			assert(err.message.includes('0x17ed'));
		}

		await driftClient.updatePerpMarketContractTier(0, ContractTier.A);
		const tx1 = await driftClient.updatePerpMarketMaxImbalances(
			marketIndex,
			new BN(40000).mul(QUOTE_PRECISION),
			QUOTE_PRECISION,
			QUOTE_PRECISION
		);
		await printTxLogs(connection, tx1);

		await driftClient.fetchAccounts();
		const marketBeforeBankruptcy =
			driftClient.getPerpMarketAccount(marketIndex);
		assert(
			marketBeforeBankruptcy.insuranceClaim.revenueWithdrawSinceLastSettle.eq(
				ZERO
			)
		);
		assert(
			marketBeforeBankruptcy.insuranceClaim.quoteSettledInsurance.eq(ZERO)
		);
		assert(
			marketBeforeBankruptcy.insuranceClaim.quoteMaxInsurance.eq(
				QUOTE_PRECISION
			)
		);
		assert(marketBeforeBankruptcy.amm.totalSocialLoss.eq(ZERO));
		await liquidatorDriftClient.resolvePerpBankruptcy(
			await driftClient.getUserAccountPublicKey(),
			driftClient.getUserAccount(),
			0
		);

		await driftClient.fetchAccounts();
		// all social loss
		const marketAfterBankruptcy = driftClient.getPerpMarketAccount(marketIndex);
		assert(
			marketAfterBankruptcy.insuranceClaim.revenueWithdrawSinceLastSettle.eq(
				ZERO
			)
		);
		assert(marketAfterBankruptcy.insuranceClaim.quoteSettledInsurance.eq(ZERO));
		assert(
			marketAfterBankruptcy.insuranceClaim.quoteMaxInsurance.eq(QUOTE_PRECISION)
		);
		console.log(
			'marketAfterBankruptcy.amm.feePool.scaledBalance:',
			marketAfterBankruptcy.amm.feePool.scaledBalance.toString()
		);
		assert(marketAfterBankruptcy.amm.feePool.scaledBalance.eq(ZERO));
		console.log(
			'marketAfterBankruptcy.amm.totalSocialLoss:',
			marketAfterBankruptcy.amm.totalSocialLoss.toString()
		);
		assert(marketAfterBankruptcy.amm.totalSocialLoss.eq(new BN(5767507)));

		// assert(!driftClient.getUserAccount().isBankrupt);
		// assert(!driftClient.getUserAccount().isBeingLiquidated);
		assert(!isVariant(driftClient.getUserAccount().status, 'beingLiquidated'));
		assert(!isVariant(driftClient.getUserAccount().status, 'bankrupt'));
		assert(isVariant(driftClient.getUserAccount().status, 'active'));

		assert(
			driftClient.getUserAccount().perpPositions[0].quoteAssetAmount.eq(ZERO)
		);
		assert(driftClient.getUserAccount().perpPositions[0].lpShares.eq(ZERO));

		const perpBankruptcyRecord =
			eventSubscriber.getEventsArray('LiquidationRecord')[0];
		assert(isVariant(perpBankruptcyRecord.liquidationType, 'perpBankruptcy'));
		assert(perpBankruptcyRecord.perpBankruptcy.marketIndex === 0);
		assert(perpBankruptcyRecord.perpBankruptcy.pnl.eq(new BN(-5785008)));
		console.log(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.toString()
		);
		assert(
			perpBankruptcyRecord.perpBankruptcy.cumulativeFundingRateDelta.eq(
				new BN(329572000)
			)
		);

		const market = driftClient.getPerpMarketAccount(0);
		console.log(
			market.amm.cumulativeFundingRateLong.toString(),
			market.amm.cumulativeFundingRateShort.toString()
		);
		assert(market.amm.cumulativeFundingRateLong.eq(new BN(329572000)));
		assert(market.amm.cumulativeFundingRateShort.eq(new BN(-329572000)));
	});
});
