import * as dotenv from "dotenv";
// import { ethers } from "ethers";
import {ethers} from "hardhat";
import { Contract, ContractFactory, BigNumber, BigNumberish } from "ethers";
//@ts-ignore
import { poseidonContract, buildPoseidon } from "circomlibjs";
import {Receiver__factory} from "../types";
import { scrollNet, poseidonAddr, receiverScroll } from "../const";
// @ts-ignore
import { MerkleTree, Hasher } from "../src/merkleTree";
// @ts-ignore
import { groth16 } from "snarkjs";
import path from "path";

async function main(){
    // the one invoke receiver contract to send tx
    const userOldSignerWallet = new ethers.Wallet(process.env.scrollSigner ?? "");
    const provider = new ethers.providers.StaticJsonRpcProvider(
        scrollNet.url,
        scrollNet.chainId
      );
    const userOldSigner = userOldSignerWallet.connect(provider);
    // the relayer params of withdraw method
    const relayerSignerWallet = new ethers.Wallet(process.env.relayerSigner ?? "");
    const relayerSigner = relayerSignerWallet.connect(provider);
    // the recepient params of withdraw method
    const userNewSignerWallet = new ethers.Wallet(process.env.userNewSigner ?? "");
    const userNewSigner = userNewSignerWallet.connect(provider);

    const poseidon = await buildPoseidon();
    const receiverContract = new Receiver__factory(userOldSigner).attach(ethers.utils.getAddress(receiverScroll));
    const ETH_AMOUNT = ethers.utils.parseEther("0.001");
    const HEIGHT = 20;
    console.log("pass 1");
    const tree = new MerkleTree(
        HEIGHT,
        "test",
        new PoseidonHasher(poseidon)
    );
    // need get deposit create with nullifier
    // the old root
    // copy the output of sender.ts
    const nullifier = new Uint8Array([
        245,  66, 223, 148,  53,
        111,  36,  40, 254, 172,
        199, 165,  49, 154, 149
      ])
   // const nullifierHash = "0x1a47daa6190b647882c9f9a3ca67d761406a67d7be50adfb15aa0cca4d2fd18e"
    const leafIndex = 0
    const nullifierHash = poseidonHash(poseidon, [nullifier, 1, leafIndex])
    const commitment = "0x2501c5ec3e01047338b5fc27f023318750bb7bcf8a4a2976022945abb47721e6"
    console.log(tree);
    
    //console.log(await tree.root(), await tornadoContract.roots(0));
    await tree.insert(commitment);
    //console.log(tree.totalElements, await tornadoContract.nextIndex());
    //check the new root after deposit
    console.log(await tree.root(), await receiverContract.roots(1));

    const recipient = await userNewSigner.getAddress();
    const relayer = await relayerSigner.getAddress();
    const fee = 0;

    const { root, path_elements, path_index } = await tree.path(
         leafIndex
    );

    const witness = {
        // Public
        root,
        nullifierHash,
        recipient,
        relayer,
        fee,
        // Private (user keep)
        nullifier: BigNumber.from(nullifier).toBigInt(),
        pathElements: path_elements,
        pathIndices: path_index,
    };

    const solProof = await prove(witness);
    console.log(solProof)
    // relayerSinger sign tx and pay gas fee, so relayerSinger should have balance
    const txWithdraw = await receiverContract
        .connect(relayerSigner)
        .withdraw(solProof, root, nullifierHash, recipient, relayer, fee);
    const receiptWithdraw = await txWithdraw.wait();
    console.log("Withdraw gas cost", receiptWithdraw.gasUsed.toNumber()); 
    console.log("Withdraw tx hash", txWithdraw.hash);

}

class PoseidonHasher implements Hasher {
    poseidon: any;

    constructor(poseidon: any) {
        this.poseidon = poseidon;
    }

    hash(left: string, right: string) {
        return poseidonHash(this.poseidon, [left, right]);
    }
}

function poseidonHash(poseidon: any, inputs: any): string {
    const hash = poseidon(inputs.map((x: any) => ethers.BigNumber.from(x).toBigInt()));
    // Make the number within the field size
    const hashStr = poseidon.F.toString(hash);
    // Make it a valid hex string
    const hashHex = ethers.BigNumber.from(hashStr).toHexString();
    // pad zero to make it 32 bytes, so that the output can be taken as a bytes32 contract argument
    const bytes32 = ethers.utils.hexZeroPad(hashHex, 32);
    return bytes32;
}

interface Proof {
    a: [BigNumberish, BigNumberish];
    b: [[BigNumberish, BigNumberish], [BigNumberish, BigNumberish]];
    c: [BigNumberish, BigNumberish];
}

async function prove(witness: any): Promise<Proof> {
    const wasmPath = path.join(__dirname, "../build/withdraw_js/withdraw.wasm");
    const zkeyPath = path.join(__dirname, "../build/circuit_final.zkey");

    const { proof } = await groth16.fullProve(witness, wasmPath, zkeyPath);
    const solProof: Proof = {
        a: [proof.pi_a[0], proof.pi_a[1]],
        b: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]],
        ],
        c: [proof.pi_c[0], proof.pi_c[1]],
    };
    return solProof;
}

class Deposit {
    public constructor(
        public readonly nullifier: Uint8Array,
        public poseidon: any,
        public leafIndex?: number
    ) {
        this.poseidon = poseidon;
    }
    static new(poseidon: any) {
        // random nullifier (private note)
        // here we only have private nullifier 
        const nullifier = ethers.utils.randomBytes(15);
        return new this(nullifier, poseidon);
    }
    // get hash of secret (nullifier)
    get commitment() {
        return poseidonHash(this.poseidon, [this.nullifier, 0]);
    }
    // get hash f nullifierhash (nulifier+1+index)
    get nullifierHash() {
        if (!this.leafIndex && this.leafIndex !== 0)
            throw Error("leafIndex is unset yet");
        return poseidonHash(this.poseidon, [this.nullifier, 1, this.leafIndex]);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })