// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title LocalWXDAI
/// @notice WETH9-style wrapped native coin for LOCAL TEST CHAINS ONLY (anvil, chainId
///         31337). Deployed by {Deploy} when no CURRENCY override is given so the e2e
///         suite can wrap dev-account coin via `deposit()` exactly like WXDAI on Gnosis.
///         Never deployed on Gnosis — the real WXDAI address is pinned in {Deploy}.
contract LocalWXDAI {
    string public constant name = "Wrapped XDAI (local test)";
    string public constant symbol = "WXDAI";
    uint8 public constant decimals = 18;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "insufficient");
        balanceOf[msg.sender] -= wad;
        (bool okSend,) = msg.sender.call{value: wad}("");
        require(okSend, "send failed");
        emit Withdrawal(msg.sender, wad);
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address spender, uint256 wad) external returns (bool) {
        allowance[msg.sender][spender] = wad;
        emit Approval(msg.sender, spender, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "insufficient");
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "allowance");
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}
