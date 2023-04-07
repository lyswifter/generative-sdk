import BigNumber from "bignumber.js";
import { Inscription, UTXO } from "./types";
declare const getBTCBalance: (params: {
    utxos: UTXO[];
    inscriptions: {
        [key: string]: Inscription[];
    };
}) => BigNumber;
export { getBTCBalance, };
