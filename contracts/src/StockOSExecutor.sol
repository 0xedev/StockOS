// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract StockOSExecutor {
    address public immutable owner;
    bool public paused;
    mapping(address => bool) public allowedRouter;
    mapping(address => bool) public allowedToken;
    event Executed(bytes32 indexed strategyId, address indexed router, address sellToken, address buyToken, uint256 sellAmount);
    modifier onlyOwner(){ require(msg.sender == owner, "NOT_OWNER"); _; }
    constructor(){ owner = msg.sender; }
    function setPaused(bool value) external onlyOwner { paused = value; }
    function setRouter(address router, bool allowed) external onlyOwner { allowedRouter[router] = allowed; }
    function setToken(address token, bool allowed) external onlyOwner { allowedToken[token] = allowed; }
    function execute(bytes32 strategyId,address router,address sellToken,address buyToken,uint256 sellAmount,bytes calldata data) external onlyOwner returns(bytes memory result){
        require(!paused,"PAUSED"); require(allowedRouter[router],"ROUTER"); require(allowedToken[sellToken]&&allowedToken[buyToken],"TOKEN"); require(sellAmount>0,"AMOUNT");
        (bool ok, bytes memory out)=router.call(data); require(ok,"CALL_FAILED"); emit Executed(strategyId,router,sellToken,buyToken,sellAmount); return out;
    }
}
