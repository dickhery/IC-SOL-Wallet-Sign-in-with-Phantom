// src/sol_icp_poc_frontend/assets/sol_icp_poc_backend.idl.js
import { IDL } from "https://cdn.jsdelivr.net/npm/@dfinity/candid@3.1.0/+esm";

export const idlFactory = ({ IDL }) => {
  const Result = IDL.Variant({ 'Ok' : IDL.Nat64, 'Err' : IDL.Text });
  const Result_1 = IDL.Variant({ 'Ok' : IDL.Text, 'Err' : IDL.Text });
  return IDL.Service({
    'get_balance' : IDL.Func([IDL.Text], [Result], []),
    'get_balance_ii' : IDL.Func([], [Result], []),
    'get_deposit_address' : IDL.Func([IDL.Text], [IDL.Text], ['query']),
    'get_deposit_address_ii' : IDL.Func([], [Result_1], []),
    'get_nonce' : IDL.Func([IDL.Text], [Result], []),
    'get_nonce_ii' : IDL.Func([], [Result], []),
    'get_pid' : IDL.Func([IDL.Text], [IDL.Text], ['query']),
    'get_sol_balance' : IDL.Func([IDL.Text], [Result], []),
    'get_sol_balance_ii' : IDL.Func([], [Result], []),
    'get_sol_deposit_address' : IDL.Func([IDL.Text], [Result_1], []),
    'get_sol_deposit_address_ii' : IDL.Func([], [Result_1], []),
    'link_sol_pubkey' : IDL.Func([IDL.Text, IDL.Vec(IDL.Nat8)], [IDL.Text], []),
    'transfer' : IDL.Func(
        [IDL.Text, IDL.Nat64, IDL.Text, IDL.Vec(IDL.Nat8), IDL.Nat64],
        [IDL.Text],
        [],
      ),
    'transfer_ii' : IDL.Func([IDL.Text, IDL.Nat64], [IDL.Text], []),
    'transfer_sol' : IDL.Func(
        [IDL.Text, IDL.Nat64, IDL.Text, IDL.Vec(IDL.Nat8), IDL.Nat64],
        [IDL.Text],
        [],
      ),
    'transfer_sol_ii' : IDL.Func([IDL.Text, IDL.Nat64], [IDL.Text], []),
    'unlink_sol_pubkey' : IDL.Func([], [IDL.Text], []),
    'whoami' : IDL.Func([], [IDL.Text], ['query']),
  });
};
export const init = ({ IDL }) => { return []; };

export default idlFactory;
