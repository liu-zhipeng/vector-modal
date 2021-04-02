import { EngineEvents, FullChannelState, ERC20Abi, TransferQuote } from "@connext/vector-types";
import { BrowserNode } from "@connext/vector-browser-node";
import { getBalanceForAssetId, getRandomBytes32 } from "@connext/vector-utils";
import { BigNumber, Contract, constants, utils } from "ethers";
import AwesomeDebouncePromise from "awesome-debounce-promise";
import {
  CHAIN_DETAIL,
  SetupParamsSchema,
  InitParamsSchema,
  EstimateFeeParamsSchema,
  EstimateFeeResponseSchema,
  DepositParamsSchema,
  TransferParamsSchema,
  WithdrawParamsSchema,
  CrossChainSwapParamsSchema,
  CheckPendingTransferResponseSchema,
  InitResponseSchema,
} from "../constants";
import {
  getChain,
  connectNode,
  createEvtContainer,
  EvtContainer,
  getChannelForChain,
  verifyAndGetRouterSupports,
  reconcileDeposit,
  cancelHangingToTransfers,
  waitForSenderCancels,
  getCrosschainFee,
  verifyRouterCapacityForTransfer,
  createFromAssetTransfer,
  resolveToAssetTransfer,
  withdrawToAsset,
  cancelToAssetTransfer,
} from "../utils";

export { BrowserNode, ERC20Abi, FullChannelState, getBalanceForAssetId, TransferQuote };

export class ConnextSdk {
  public routerPublicIdentifier = "";
  public senderChainChannelAddress = "";
  public recipientChainChannelAddress = "";
  public crossChainTransferId = "";
  public senderChainChannel?: FullChannelState;
  public recipientChainChannel?: FullChannelState;
  public senderChain?: CHAIN_DETAIL;
  public recipientChain?: CHAIN_DETAIL;
  public browserNode: BrowserNode | undefined;

  private evts?: EvtContainer;
  private swapDefinition?: any;

  private getFeesDebounced = AwesomeDebouncePromise(getCrosschainFee, 200);

  async init(params: InitParamsSchema): Promise<InitResponseSchema> {
    try {
      await this.setup({
        routerPublicIdentifier: params.routerPublicIdentifier,
        loginProvider: params.loginProvider,
        senderChainProvider: params.senderChainProvider,
        senderAssetId: params.senderAssetId,
        recipientChainProvider: params.recipientChainProvider,
        recipientAssetId: params.recipientAssetId,
        senderChainId: params.senderChainId,
        recipientChainId: params.recipientChainId,
        iframeSrcOverride: params.iframeSrcOverride,
      });
    } catch (e) {
      const message = "Failed at Setup";
      console.log(e, message);
      throw e;
    }

    try {
      const response = await this.checkPendingTransfer();
      console.log("SUCCESS INIT");
      return response;
    } catch (e) {
      const message = "Failed at Pending Tranfer Check";
      console.log(e, message);
      throw e;
    }
  }

  async setup(params: SetupParamsSchema) {
    this.routerPublicIdentifier = params.routerPublicIdentifier;

    let senderChainInfo: CHAIN_DETAIL;
    try {
      senderChainInfo = await getChain(params.senderChainId, params.senderChainProvider, params.senderAssetId);
      this.senderChain = senderChainInfo;
    } catch (e) {
      const message = "Failed to fetch sender chain info";
      console.log(e, message);
      throw e;
    }

    let recipientChainInfo: CHAIN_DETAIL;
    try {
      recipientChainInfo = await getChain(
        params.recipientChainId,
        params.recipientChainProvider,
        params.recipientAssetId,
      );
      this.recipientChain = recipientChainInfo;
    } catch (e) {
      const message = "Failed to fetch receiver chain info";
      console.log(e, message);
      throw e;
    }

    // setup browser node
    let _node: BrowserNode;
    try {
      // call isAlive if node set already (i.e. retry)
      if (this.browserNode && this.senderChainChannelAddress && this.recipientChainChannelAddress) {
        console.log("node found, sending isAlive message");
        const [depositRes, withdrawRes] = await Promise.all([
          this.browserNode.sendIsAliveMessage({
            channelAddress: this.senderChainChannelAddress,
            skipCheckIn: false,
          }),
          this.browserNode.sendIsAliveMessage({
            channelAddress: this.recipientChainChannelAddress,
            skipCheckIn: false,
          }),
        ]);
        console.log("messages sent", depositRes.isError, withdrawRes.isError);
      }
      // browser node object
      _node =
        this.browserNode ??
        (await connectNode(
          params.routerPublicIdentifier,
          senderChainInfo.chainId,
          recipientChainInfo.chainId,
          senderChainInfo.chainProvider,
          recipientChainInfo.chainProvider,
          params.loginProvider,
          params.iframeSrcOverride,
        ));
      this.browserNode = _node;
    } catch (e) {
      const message = "Error initalizing Browser Node";
      console.log(e, message);
      throw e;
    }

    console.log("INITIALIZED BROWSER NODE");

    const _evts = this.evts ?? createEvtContainer(_node);
    this.evts = _evts;

    let senderChainChannel: FullChannelState;
    try {
      senderChainChannel = await getChannelForChain(_node, params.routerPublicIdentifier, senderChainInfo.chainId);
      console.log("SETTING DepositChannel: ", senderChainChannel);
    } catch (e) {
      const message = "Could not get sender channel";
      console.log(e, message);
      throw e;
    }
    const senderChainChannelAddress = senderChainChannel!.channelAddress;
    this.senderChainChannelAddress = senderChainChannelAddress;

    let recipientChainChannel: FullChannelState;
    try {
      recipientChainChannel = await getChannelForChain(
        _node,
        params.routerPublicIdentifier,
        recipientChainInfo.chainId,
      );
      console.log("SETTING _withdrawChannel: ", recipientChainChannel);
    } catch (e) {
      const message = "Could not get sender channel";
      console.log(e, message);
      throw e;
    }

    const recipientChainChannelAddress = recipientChainChannel?.channelAddress!;
    this.recipientChainChannel = recipientChainChannel;
    this.recipientChainChannelAddress = recipientChainChannelAddress;

    // Verify router supports...
    try {
      const swap = await verifyAndGetRouterSupports(
        _node,
        senderChainInfo.chainId,
        senderChainInfo.assetId,
        recipientChainInfo.chainId,
        recipientChainInfo.assetId,
        recipientChainInfo.rpcProvider,
        params.routerPublicIdentifier,
      );
      this.swapDefinition = swap;
    } catch (e) {
      const message = "Error in verifyRouterSupports";
      console.log(e, message);
      throw e;
    }
  }

  async checkPendingTransfer(): Promise<CheckPendingTransferResponseSchema> {
    try {
      await reconcileDeposit(this.browserNode!, this.senderChainChannelAddress, this.senderChain?.assetId!);
    } catch (e) {
      if (e.message.includes("must restore") || (e.context?.message ?? "").includes("must restore")) {
        console.warn(
          "Channel is out of sync, restoring before other operations. The channel was likely used in another browser.",
        );
        const restoreDepositChannelState = await this.browserNode!.restoreState({
          counterpartyIdentifier: this.routerPublicIdentifier,
          chainId: this.senderChain?.chainId!,
        });
        if (restoreDepositChannelState.isError) {
          const message = "Could not restore sender channel state";
          console.error(message, restoreDepositChannelState.getError());
          throw restoreDepositChannelState.getError();
        }
        const restoreWithdrawChannelState = await this.browserNode!.restoreState({
          counterpartyIdentifier: this.routerPublicIdentifier,
          chainId: this.recipientChain?.chainId!,
        });
        if (restoreWithdrawChannelState.isError) {
          const message = "Could not restore receiver channel state";
          console.error(message, restoreWithdrawChannelState.getError());
          throw restoreWithdrawChannelState.getError();
        }
        try {
          await reconcileDeposit(this.browserNode!, this.senderChainChannelAddress, this.senderChain?.assetId!);
        } catch (e) {
          const message = "Error in reconcileDeposit";
          console.error(message, e);
          throw e;
        }
      } else {
        const message = "Error in reconcileDeposit";
        console.error(message, e);
        throw e;
      }
    }

    // prune any existing receiver transfers
    try {
      const hangingResolutions = await cancelHangingToTransfers(
        this.browserNode!,
        this.evts![EngineEvents.CONDITIONAL_TRANSFER_CREATED],
        this.senderChain?.chainId!,
        this.recipientChain?.chainId!,
        this.recipientChain?.assetId!,
        this.routerPublicIdentifier,
      );
      console.log("Found hangingResolutions: ", hangingResolutions);
    } catch (e) {
      const message = "Error in cancelHangingToTransfers";
      console.log(e, message);
      throw e;
    }

    // get active transfers
    const [depositActive, withdrawActive] = await Promise.all([
      this.browserNode!.getActiveTransfers({
        channelAddress: this.senderChainChannelAddress,
      }),
      this.browserNode!.getActiveTransfers({
        channelAddress: this.recipientChainChannelAddress,
      }),
    ]);
    const depositHashlock = depositActive.getValue().filter(t => Object.keys(t.transferState).includes("lockHash"));
    const withdrawHashlock = withdrawActive.getValue().filter(t => Object.keys(t.transferState).includes("lockHash"));
    console.warn(
      "deposit active on init",
      depositHashlock.length,
      "ids:",
      depositHashlock.map(t => t.transferId),
    );
    console.warn(
      "withdraw active on init",
      withdrawHashlock.length,
      "ids:",
      withdrawHashlock.map(t => t.transferId),
    );

    // set a listener to check for transfers that may have been pushed after a refresh after the hanging transfers have already been canceled
    this.evts!.CONDITIONAL_TRANSFER_CREATED.pipe(data => {
      return (
        data.transfer.responderIdentifier === this.browserNode!.publicIdentifier &&
        data.transfer.meta.routingId !== this.crossChainTransferId
      );
    }).attach(async data => {
      console.warn("Cancelling transfer thats not active");
      const senderResolution = this.evts!.CONDITIONAL_TRANSFER_RESOLVED.pipe(
        data =>
          data.transfer.meta.crossChainTransferId === this.crossChainTransferId &&
          data.channelAddress === this.senderChainChannelAddress,
      ).waitFor(45_000);

      const receiverResolution = this.evts!.CONDITIONAL_TRANSFER_RESOLVED.pipe(
        data =>
          data.transfer.meta.crossChainTransferId === this.crossChainTransferId &&
          data.channelAddress === this.recipientChainChannelAddress,
      ).waitFor(45_000);
      try {
        await cancelToAssetTransfer(this.browserNode!, this.recipientChainChannelAddress, data.transfer.transferId);
      } catch (e) {
        const message = "Error in cancelToAssetTransfer";
        console.log(e, message);
        throw e;
      }

      try {
        await Promise.all([senderResolution, receiverResolution]);
        const message = "Transfer was cancelled";
        console.log(message);
        throw new Error(message);
      } catch (e) {
        const message = "Error waiting for sender and receiver cancellations";
        console.log(e, message);
        throw e;
      }
    });

    try {
      console.log("Waiting for sender cancellations..");
      await waitForSenderCancels(
        this.browserNode!,
        this.evts![EngineEvents.CONDITIONAL_TRANSFER_RESOLVED],
        this.senderChainChannelAddress,
      );
      console.log("done!");
    } catch (e) {
      const message = "Error in waitForSenderCancels";
      console.log(e, message);
      throw e;
    }

    // After reconciling, get channel again
    try {
      this.senderChainChannel = await getChannelForChain(
        this.browserNode!,
        this.routerPublicIdentifier,
        this.senderChain?.chainId!,
      );
    } catch (e) {
      const message = "Could not get sender channel";
      console.log(e, message);
      throw e;
    }

    const offChainSenderChainAssetBalance = BigNumber.from(
      getBalanceForAssetId(this.senderChainChannel, this.senderChain?.assetId!, "bob"),
    );
    console.log(
      `Offchain balance for ${this.senderChainChannelAddress} of asset ${this.senderChain
        ?.assetId!}: ${offChainSenderChainAssetBalance}`,
    );

    const offChainRecipientChainAssetBalance = BigNumber.from(
      getBalanceForAssetId(this.recipientChainChannel!, this.recipientChain?.assetId!, "bob"),
    );
    console.log(
      `Offchain balance for ${this.recipientChainChannelAddress} of asset ${this.recipientChain
        ?.assetId!}: ${offChainRecipientChainAssetBalance}`,
    );

    return {
      offChainSenderChainAssetBalanceBn: offChainSenderChainAssetBalance,
      offChainRecipientChainAssetBalanceBn: offChainRecipientChainAssetBalance,
    };
  }

  async estimateFees(params: EstimateFeeParamsSchema): Promise<EstimateFeeResponseSchema> {
    const { transferAmount: _transferAmount, isRecipientAssetInput, userBalanceWei } = params;

    const transferAmount = _transferAmount ? _transferAmount.trim() : undefined;
    let err: string | undefined = undefined;

    if (!transferAmount) {
      return {
        error: err,
        senderAmount: "",
        recipientAmount: "",
        totalFee: undefined,
        transferQuote: undefined,
      };
    }

    let senderAmountUi: string | undefined = isRecipientAssetInput ? "" : transferAmount;
    let recipientAmountUi: string | undefined = isRecipientAssetInput ? transferAmount : "";
    let totalFee: string | undefined = undefined;
    let transferQuote: TransferQuote | undefined = undefined;

    try {
      const transferAmountBn = BigNumber.from(
        utils.parseUnits(
          transferAmount,
          isRecipientAssetInput ? this.recipientChain?.assetDecimals! : this.senderChain?.assetDecimals!,
        ),
      );

      if (transferAmountBn.isZero()) {
        err = "Transfer amount cannot be 0";
        return {
          error: err,
          senderAmount: senderAmountUi,
          recipientAmount: recipientAmountUi,
          totalFee: totalFee,
          transferQuote: transferQuote,
        };
      }

      let feeBn: BigNumber;
      let senderAmountBn: BigNumber;
      let recipientAmountBn: BigNumber;
      try {
        const {
          totalFee,
          senderAmount: _senderAmount,
          recipientAmount: _recipientAmount,
          transferQuote: _transferQuote,
        } = await this.getFeesDebounced(
          this.browserNode!,
          this.routerPublicIdentifier,
          transferAmountBn,
          this.senderChain?.chainId!,
          this.senderChain?.assetId!,
          this.senderChain?.assetDecimals!,
          this.recipientChain?.chainId!,
          this.recipientChain?.assetId!,
          this.recipientChain?.assetDecimals!,
          this.swapDefinition!,
          isRecipientAssetInput,
        );
        feeBn = totalFee;
        senderAmountBn = BigNumber.from(_senderAmount);
        recipientAmountBn = BigNumber.from(_recipientAmount);
        transferQuote = _transferQuote;
      } catch (e) {
        return {
          error: e.message,
          senderAmount: senderAmountUi,
          recipientAmount: recipientAmountUi,
          totalFee: totalFee,
          transferQuote: transferQuote,
        };
      }

      totalFee = utils.formatUnits(feeBn, this.senderChain?.assetDecimals!);
      console.log("feeUi: ", totalFee);

      if (BigNumber.from(recipientAmountBn).lte(0)) {
        const err = "Not enough amount to pay fees";
        return {
          error: err,
          senderAmount: senderAmountUi,
          recipientAmount: recipientAmountUi,
          totalFee: totalFee,
          transferQuote: transferQuote,
        };
      }

      if (isRecipientAssetInput) {
        senderAmountUi = utils.formatUnits(senderAmountBn, this.senderChain?.assetDecimals!);
        console.log("senderUi: ", senderAmountUi);
      } else {
        recipientAmountUi = utils.formatUnits(recipientAmountBn, this.recipientChain?.assetDecimals!);
        console.log("receivedUi: ", recipientAmountUi);
      }

      if (userBalanceWei) {
        const userBalanceBn = BigNumber.from(utils.parseUnits(userBalanceWei, this.senderChain?.assetDecimals!));
        if (senderAmountBn.gt(userBalanceBn)) {
          err = "Transfer amount exceeds user balance";
          return {
            error: err,
            senderAmount: senderAmountUi,
            recipientAmount: recipientAmountUi,
            totalFee: totalFee,
            transferQuote: transferQuote,
          };
        }
      }
    } catch (e) {
      err = "Invalid amount";
    }

    return {
      error: err,
      senderAmount: senderAmountUi,
      recipientAmount: recipientAmountUi,
      totalFee: totalFee,
      transferQuote: transferQuote,
    };
  }

  async preTransferCheck(transferAmount: string) {
    if (!transferAmount) {
      const message = "Transfer Amount is undefined";
      console.log(message);
      throw new Error(message);
    }
    const transferAmountBn: BigNumber = BigNumber.from(
      utils.parseUnits(transferAmount, this.senderChain?.assetDecimals!),
    );

    if (transferAmountBn.isZero()) {
      const message = "Transfer amount cannot be 0";
      console.log(message);
      throw new Error(message);
    }

    console.log("Verify Router Capacity");
    try {
      await verifyRouterCapacityForTransfer(
        this.recipientChain?.rpcProvider!,
        this.recipientChain?.assetId!,
        this.recipientChain?.assetDecimals!,
        this.recipientChainChannel!,
        transferAmountBn,
        this.swapDefinition!,
        this.senderChain?.assetDecimals!,
      );
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  async deposit(params: DepositParamsSchema) {
    const { transferAmount, preTransferCheck = true, webProvider, onDeposited } = params;

    if (preTransferCheck) {
      try {
        await this.preTransferCheck(transferAmount);
      } catch (e) {
        console.log("Error at preCheck", e);
        throw e;
      }
    }

    const transferAmountBn = BigNumber.from(utils.parseUnits(transferAmount, this.senderChain?.assetDecimals!));
    console.log(transferAmountBn);

    try {
      const signer = webProvider.getSigner();

      const depositTx =
        this.senderChain?.assetId! === constants.AddressZero
          ? await signer.sendTransaction({
              to: this.senderChainChannelAddress!,
              value: transferAmountBn,
            })
          : await new Contract(this.senderChain?.assetId!, ERC20Abi, signer).transfer(
              this.senderChainChannelAddress!,
              transferAmountBn,
            );

      const receipt = await depositTx.wait();
      console.log("deposit mined:", receipt.transactionHash);

      this.senderChain?.rpcProvider!.waitForTransaction(depositTx.hash, 2).then(receipt => {
        if (receipt.status === 0) {
          // tx reverted
          const message = "Transaction reverted onchain";
          console.error(message, receipt);
          throw new Error(message);
        }
      });
      if (onDeposited) {
        onDeposited(depositTx.hash);
      }
    } catch (e) {
      console.log("Error at deposit", e);
      throw e;
    }
  }

  async transfer(params: TransferParamsSchema) {
    const { transferQuote } = params;
    const crossChainTransferId = getRandomBytes32();
    const preImage = getRandomBytes32();

    this.crossChainTransferId = crossChainTransferId;

    console.log(`Calling reconcileDeposit with ${this.senderChainChannelAddress!} and ${this.senderChain?.assetId!}`);
    await reconcileDeposit(this.browserNode!, this.senderChainChannelAddress!, this.senderChain?.assetId!);

    try {
      console.log(
        `Calling createFromAssetTransfer ${this.senderChain?.chainId!} ${this.senderChain?.assetId!} ${
          this.recipientChain?.chainId
        } ${this.recipientChain?.assetId} ${crossChainTransferId}`,
      );
      const transferDeets = await createFromAssetTransfer(
        this.browserNode!,
        this.senderChain?.chainId!,
        this.senderChain?.assetId!,
        this.recipientChain?.chainId!,
        this.recipientChain?.assetId!,
        this.routerPublicIdentifier,
        crossChainTransferId,
        preImage,
        transferQuote,
      );
      console.log("createFromAssetTransfer transferDeets: ", transferDeets);
    } catch (e) {
      if (e.message.includes("Fees charged are greater than amount")) {
        const message = "Last requested transfer is lower than fees charged";
        console.error(message, e);
        throw new Error(message);
      }
      console.log(e);
      throw e;
    }

    // listen for a sender-side cancellation, if it happens, short-circuit and show cancellation
    const senderCancel = this.evts![EngineEvents.CONDITIONAL_TRANSFER_RESOLVED].pipe(data => {
      return (
        data.transfer.meta?.routingId === crossChainTransferId &&
        data.transfer.responderIdentifier === this.routerPublicIdentifier &&
        Object.values(data.transfer.transferResolver)[0] === constants.HashZero
      );
    }).waitFor(500_000);

    const receiverCreate = this.evts![EngineEvents.CONDITIONAL_TRANSFER_CREATED].pipe(data => {
      return (
        data.transfer.meta?.routingId === crossChainTransferId &&
        data.transfer.initiatorIdentifier === this.routerPublicIdentifier
      );
    }).waitFor(500_000);

    // wait a long time for this, it needs to send onchain txs
    // if the receiver create doesnt complete, sender side can get cancelled
    try {
      const senderCanceledOrReceiverCreated = await Promise.race([senderCancel, receiverCreate]);
      console.log("Received senderCanceledOrReceiverCreated: ", senderCanceledOrReceiverCreated);
      if (Object.values(senderCanceledOrReceiverCreated.transfer.transferResolver ?? {})[0] === constants.HashZero) {
        const message = "Transfer was cancelled";
        console.log(message);
        throw new Error(message);
      }
    } catch (e) {
      const message = "Did not receive transfer after 500 seconds, please try again later or attempt recovery";
      console.log(e, message);
      throw e;
    }

    const senderResolve = this.evts![EngineEvents.CONDITIONAL_TRANSFER_RESOLVED].pipe(data => {
      return (
        data.transfer.meta?.routingId === crossChainTransferId &&
        data.transfer.responderIdentifier === this.routerPublicIdentifier
      );
    }).waitFor(45_000);

    try {
      await resolveToAssetTransfer(
        this.browserNode!,
        this.recipientChain?.chainId!,
        preImage,
        crossChainTransferId,
        this.routerPublicIdentifier,
      );
    } catch (e) {
      const message = "Error in resolveToAssetTransfer";
      console.log(message);
      throw new Error(message);
    }

    try {
      await senderResolve;
    } catch (e) {
      console.warn("Did not find resolve event from router, proceeding with withdrawal", e);
    }
  }

  async withdraw(params: WithdrawParamsSchema) {
    const { recipientAddress, onFinished, withdrawalCallTo, withdrawalCallData, generateCallData } = params;
    // now go to withdrawal screen
    let result;
    try {
      result = await withdrawToAsset(
        this.browserNode!,
        this.evts![EngineEvents.WITHDRAWAL_RESOLVED],
        this.recipientChain?.chainId!,
        this.recipientChain?.assetId!,
        recipientAddress,
        this.routerPublicIdentifier,
        withdrawalCallTo,
        withdrawalCallData,
        generateCallData,
      );
    } catch (e) {
      console.log(e);
      throw e;
    }
    // display tx hash through explorer -> handles by the event.
    console.log("crossChainTransfer: ", result);

    const successWithdrawalUi = utils.formatUnits(result.withdrawalAmount, this.recipientChain?.assetDecimals!);

    console.log(successWithdrawalUi);

    if (onFinished) {
      onFinished(result.withdrawalTx, successWithdrawalUi, BigNumber.from(result.withdrawalAmount));
    }

    // check tx receipt for withdrawal tx
    this.recipientChain?.rpcProvider.waitForTransaction(result.withdrawalTx).then(receipt => {
      if (receipt.status === 0) {
        // tx reverted
        const message = "Transaction reverted onchain";
        console.error(message, receipt);
        throw new Error(message);
      }
    });
  }

  async crossChainSwap(params: CrossChainSwapParamsSchema) {
    const {
      recipientAddress,
      onFinished,
      transferQuote,
      withdrawalCallTo,
      withdrawalCallData,
      generateCallData,
    } = params;

    try {
      await this.transfer({ transferQuote });
    } catch (e) {
      console.log("Error at Transfer", e);
      throw e;
    }

    try {
      await this.withdraw({
        recipientAddress: recipientAddress,
        onFinished: onFinished,
        withdrawalCallTo: withdrawalCallTo,
        withdrawalCallData: withdrawalCallData,
        generateCallData: generateCallData,
      });
    } catch (e) {
      console.log("Error at withdraw", e);
      throw e;
    }

    console.log("Successfully Swap");
  }
}