// Generated from forge artifacts: forge inspect src/apartments/ApartmentsCoverPoolV2.sol:ApartmentsCoverPoolV2 abi --json. Do not edit.
export const apartmentsPoolV2Abi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "currency_",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "token_",
        "type": "address",
        "internalType": "contract CoverToken"
      },
      {
        "name": "oracle_",
        "type": "address",
        "internalType": "contract IApartmentsRentOracle"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "MIN_REDEEM_WINDOW",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SUBMISSION_GRACE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "addCapacity",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "amount",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "buyProtection",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxClaim",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxPremium",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "buyProtectionFor",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxClaim",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxPremium",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelSeries",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createSeries",
    "inputs": [
      {
        "name": "slug",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "obsMonth",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "strikeLowCents",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "strikeHighCents",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "premiumRateBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "saleEnd",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "redeemEnd",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "capacity",
        "type": "uint128",
        "internalType": "uint128"
      }
    ],
    "outputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "currency",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "finalize",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "oracle",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IApartmentsRentOracle"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quote",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxClaim",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "premium",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "rateBps",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "capacityLeft",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "issuableNow",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "redeem",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "series",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct ApartmentsCoverPoolV2.Series",
        "components": [
          {
            "name": "creator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "strikeLowCents",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "strikeHighCents",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "premiumRateBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "obsMonth",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "settled",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "voided",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "cancelled",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "residualWithdrawn",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "saleEnd",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "finalizeAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "redeemEnd",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "payoutRatioWad",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "observationT",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "escrow",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "sold",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "premiumsAccrued",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "paidOut",
            "type": "uint128",
            "internalType": "uint128"
          },
          {
            "name": "slugHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "emailId",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "seriesCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "seriesPaused",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "seriesSlug",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setSeriesPaused",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "paused",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "token",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract CoverToken"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "withdrawResidual",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "CapacityAdded",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newEscrow",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProtectionBought",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "buyer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "maxClaim",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "premium",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Redeemed",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "holder",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "payout",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ResidualWithdrawn",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeriesCancelled",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "refund",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeriesCreated",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "slugHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "slug",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "obsMonth",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "strikeLowCents",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "strikeHighCents",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "premiumRateBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "saleEnd",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "finalizeAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "redeemEnd",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "capacity",
        "type": "uint128",
        "indexed": false,
        "internalType": "uint128"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeriesPausedSet",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "paused",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeriesSettled",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "payoutRatioWad",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "cents",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "observationT",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "emailId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SeriesVoided",
    "inputs": [
      {
        "name": "seriesId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyFinalized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadySold",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadMonth",
    "inputs": [
      {
        "name": "yyyymm",
        "type": "uint32",
        "internalType": "uint32"
      }
    ]
  },
  {
    "type": "error",
    "name": "CapacityExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidParams",
    "inputs": [
      {
        "name": "what",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidSeries",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotCreator",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PremiumRoundsToZero",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PremiumTooHigh",
    "inputs": [
      {
        "name": "premium",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maxPremium",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "RedeemWindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RedeemWindowOpen",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RentAlreadyRecorded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ResidualAlreadyWithdrawn",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SaleClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SalesArePaused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SeriesClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooEarly",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;
