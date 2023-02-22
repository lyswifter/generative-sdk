import {
    networks,
    payments,
    Psbt
} from "bitcoinjs-lib";
import axios, { AxiosResponse } from "axios";
import { Inscription, UTXO } from "./types";
import { BlockStreamURL, MinSatInscription } from "./constants";
import { 
    toXOnly,
    tweakSigner,
    ECPair,
    estimateTxFee, 
    estimateNumInOutputs 
} from "./utils";

/**
* selectUTXOs selects the most reasonable UTXOs to create the transaction. 
* if sending inscription, the first selected UTXO is always the UTXO contain inscription.
* @param utxos list of utxos (include non-inscription and inscription utxos)
* @param inscriptions list of inscription infos of the sender
* @param sendInscriptionID id of inscription to send
* @param sendAmount satoshi amount need to send 
* @param feeRatePerByte fee rate per byte (in satoshi)
* @param isUseInscriptionPayFee flag defines using inscription coin to pay fee 
* @returns the list of selected UTXOs
* @returns the actual flag using inscription coin to pay fee
* @returns the value of inscription outputs, and the change amount (if any)
*/
const selectUTXOs = (
    utxos: UTXO[],
    inscriptions: { [key: string]: Inscription[] },
    sendInscriptionID: string,
    sendAmount: number,
    feeRatePerByte: number,
    isUseInscriptionPayFee: boolean,
): { selectedUTXOs: UTXO[], isUseInscriptionPayFee: boolean, valueOutInscription: number, changeAmount: number } => {
    let resultUTXOs: UTXO[] = [];
    let normalUTXOs: UTXO[] = [];
    let inscriptionUTXO: any = null;
    let inscriptionInfo: any = null;
    let valueOutInscription: number = 0;
    let changeAmount: number = 0;

    // estimate fee
    let { numIns, numOuts } = estimateNumInOutputs(sendInscriptionID, sendAmount, isUseInscriptionPayFee);
    let estFee: number = estimateTxFee(numIns, numOuts, feeRatePerByte);
    console.log("Estimate fee: ", estFee, numIns, numOuts);

    // when BTC amount need to send is greater than 0, 
    // we should use normal BTC to pay fee
    if (isUseInscriptionPayFee && sendAmount > 0) {
        isUseInscriptionPayFee = false;
    }

    // filter normal UTXO and inscription UTXO to send
    utxos.forEach(utxo => {
        // txIDKey = tx_hash:tx_output_n
        let txIDKey = utxo.tx_hash.concat(":");
        txIDKey = txIDKey.concat(utxo.tx_output_n.toString());

        // try to get inscriptionInfos
        let inscriptionInfos = inscriptions[txIDKey];

        if (inscriptionInfos === undefined || inscriptionInfos === null || inscriptionInfos.length == 0) {
            // normal UTXO
            normalUTXOs.push(utxo);
        } else {
            // inscription UTXO
            if (sendInscriptionID !== "") {
                const inscription = inscriptionInfos.find(ins => ins.id === sendInscriptionID);
                if (inscription !== undefined) {
                    // don't support send tx with outcoin that includes more than one inscription
                    if (inscriptionInfos.length > 1) {
                        throw new Error(`InscriptionID ${{ sendInscriptionID }} is not supported to send.`);
                    }
                    inscriptionUTXO = utxo;
                    inscriptionInfo = inscription;
                }
            }
        }
    });


    if (sendInscriptionID !== "") {
        if (inscriptionUTXO === null || inscriptionInfo == null) {
            throw new Error("Can not find inscription UTXO for sendInscriptionID");
        }
        if (isUseInscriptionPayFee) {
            // if offset is 0: SHOULD use inscription to pay fee
            // otherwise, MUST use normal UTXOs to pay fee
            if (inscriptionInfo.offset !== 0) {
                isUseInscriptionPayFee = false;
            } else {
                // if value is not enough to pay fee, MUST use normal UTXOs to pay fee
                if (inscriptionUTXO.value < estFee + MinSatInscription) {
                    isUseInscriptionPayFee = false;
                }
            }
        }

        // push inscription UTXO to create tx
        resultUTXOs.push(inscriptionUTXO);
    }

    // select normal UTXOs
    let totalSendAmount = sendAmount;
    if (!isUseInscriptionPayFee) {
        totalSendAmount += estFee;
    }

    let totalInputAmount: number = 0;
    if (totalSendAmount > 0) {
        if (normalUTXOs.length === 0) {
            throw new Error("Insuffient BTC balance to send");
        }

        normalUTXOs = normalUTXOs.sort(
            (a: UTXO, b: UTXO): number => {
                if (a.value > b.value) {
                    return -1;
                }
                if (a.value < b.value) {
                    return 1;
                }
                return 0;
            }
        );

        console.log("normalUTXOs: ", normalUTXOs);

        if (normalUTXOs[normalUTXOs.length - 1].value >= totalSendAmount) {
            // select the smallest utxo
            resultUTXOs.push(normalUTXOs[normalUTXOs.length - 1]);
            totalInputAmount = normalUTXOs[normalUTXOs.length - 1].value;
        } else if (normalUTXOs[0].value < totalSendAmount) {
            // select multiple UTXOs
            for (let i = 0; i < normalUTXOs.length; i++) {
                let utxo = normalUTXOs[i];
                resultUTXOs.push(utxo);
                totalInputAmount += utxo.value;
                if (totalInputAmount >= totalSendAmount) {
                    break;
                }
            }
            if (totalInputAmount < totalSendAmount) {
                throw new Error("Insuffient BTC balance to send");
            }
        } else {
            // select the nearest UTXO
            let selectedUTXO = normalUTXOs[0];
            for (let i = 1; i < normalUTXOs.length; i++) {
                if (normalUTXOs[i].value < totalSendAmount) {
                    resultUTXOs.push(selectedUTXO);
                    totalInputAmount = selectedUTXO.value;
                    break;
                }

                selectedUTXO = normalUTXOs[i];
            }
        }
    }

    // re-estimate fee with exact number of inputs and outputs
    let fee: number = estimateTxFee(resultUTXOs.length, numOuts, feeRatePerByte)
    console.log("Real fee ", fee);


    // calculate output amount
    if (isUseInscriptionPayFee) {
        if (inscriptionUTXO.value < fee + MinSatInscription) {
            fee = inscriptionUTXO.value - MinSatInscription;
        }
        valueOutInscription = inscriptionUTXO.value - fee;
        changeAmount = totalInputAmount - sendAmount;
    } else {
        if (totalInputAmount < sendAmount + fee) {
            fee = totalInputAmount - sendAmount;
        }
        valueOutInscription = inscriptionUTXO?.value || 0;
        changeAmount = totalInputAmount - sendAmount - fee;
    }

    return { selectedUTXOs: resultUTXOs, isUseInscriptionPayFee: isUseInscriptionPayFee, valueOutInscription: valueOutInscription, changeAmount: changeAmount };
}


/**
* createTx creates the Bitcoin transaction (including sending inscriptions). 
* NOTE: Currently, the function only supports sending from Taproot address. 
* @param senderPrivateKey buffer private key of the sender
* @param utxos list of utxos (include non-inscription and inscription utxos)
* @param inscriptions list of inscription infos of the sender
* @param sendInscriptionID id of inscription to send
* @param receiverInsAddress the address of the inscription receiver
* @param sendAmount satoshi amount need to send 
* @param feeRatePerByte fee rate per byte (in satoshi)
* @param isUseInscriptionPayFee flag defines using inscription coin to pay fee 
* @returns returns the hex signed transaction
*/
const createTx = (
    senderPrivateKey: Buffer,
    utxos: UTXO[],
    inscriptions: { [key: string]: Inscription[] },
    sendInscriptionID: string = "",
    receiverInsAddress: string,
    sendAmount: number,
    feeRatePerByte: number,
    isUseInscriptionPayFeeParam: boolean = true,  // default is true
): string => {
    let network = networks.bitcoin;  // mainnet

    // select UTXOs
    let { selectedUTXOs, valueOutInscription, changeAmount } = selectUTXOs(utxos, inscriptions, sendInscriptionID, sendAmount, feeRatePerByte, isUseInscriptionPayFeeParam);
    console.log("selectedUTXOs: ", selectedUTXOs);

    // init key pair from senderPrivateKey
    let keypair = ECPair.fromPrivateKey(senderPrivateKey);
    // Tweak the original keypair
    const tweakedSigner = tweakSigner(keypair, { network });

    // Generate an address from the tweaked public key
    const p2pktr = payments.p2tr({
        pubkey: toXOnly(tweakedSigner.publicKey),
        network
    });
    const senderAddress = p2pktr.address ? p2pktr.address: "";
    if (senderAddress === "") {
        throw new Error("Can not get sender address from private key");
    }

    const psbt = new Psbt({ network });
    // add inputs
    selectedUTXOs.forEach((input) => {
        psbt.addInput({
            hash: input.tx_hash,
            index: input.tx_output_n,
            witnessUtxo: { value: input.value, script: p2pktr.output! },
            tapInternalKey: toXOnly(keypair.publicKey)
        });
    });

    // add outputs
    if (sendInscriptionID !== "") {
        // add output inscription
        psbt.addOutput({
            address: receiverInsAddress,
            value: valueOutInscription,
        });
    }
    // add output send BTC
    if (sendAmount > 0) {
        psbt.addOutput({
            address: receiverInsAddress,
            value: sendAmount,
        });
    }

    // add change output
    if (changeAmount > 0) {
        psbt.addOutput({
            address: senderAddress,
            value: changeAmount,
        });
    }

    // sign tx
    selectedUTXOs.forEach((utxo, index) => {
        psbt.signInput(index, tweakedSigner);
    });
    psbt.finalizeAllInputs();

    // get tx hex
    let tx = psbt.extractTransaction();
    console.log("Transaction : ", tx);
    let txHex = tx.toHex();
    console.log(`Transaction Hex: ${txHex}`);
    return txHex;
}

const broadcastTx = async (hexTx: string): Promise<string> => {
    const blockstream = new axios.Axios({
        baseURL: BlockStreamURL
    });
    const response: AxiosResponse<string> = await blockstream.post("/tx", hexTx);
    return response.data;
}

export {
    selectUTXOs,
    createTx,
    broadcastTx,
}