import { useState, useEffect } from 'react';

interface NetworkStatusProps {
  connected: boolean;
}

export function NetworkStatus({ connected }: NetworkStatusProps) {
  const [gasPrice, setGasPrice] = useState<number>(30);
  const [blockNumber, setBlockNumber] = useState<number>(0);
  const [latency, setLatency] = useState<number>(0);

  useEffect(() => {
    // Simulate network stats updates
    const interval = setInterval(() => {
      setGasPrice(25 + Math.random() * 20);
      setBlockNumber(prev => prev + Math.floor(Math.random() * 3));
      setLatency(50 + Math.random() * 100);
    }, 5000);

    // Initialize block number
    setBlockNumber(Math.floor(Date.now() / 1000) % 100000000);

    return () => clearInterval(interval);
  }, []);

  const getGasColor = (gas: number) => {
    if (gas < 30) return 'text-green-400';
    if (gas < 50) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getLatencyColor = (ms: number) => {
    if (ms < 100) return 'text-green-400';
    if (ms < 200) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div className="inline-flex items-center gap-3.5 rounded-control border border-[#1e1e2a] bg-white/[0.03] px-3.5 py-2 font-mono text-[11px]">
      {/* Latency, with the canvas's spinner ring */}
      <span className="flex items-center gap-2" title="Round-trip latency">
        <span className="spinner-ring" />
        <span className={getLatencyColor(latency)}>{latency.toFixed(0)}ms</span>
      </span>

      <span className="h-3 w-px bg-white/10" />

      {/* Gas price */}
      <span className="flex items-center gap-1.5" title="Polygon gas price">
        <span className="text-gray-600">GAS</span>
        <span className={getGasColor(gasPrice)}>{gasPrice.toFixed(0)}</span>
      </span>

      <span className="h-3 w-px bg-white/10" />

      {/* Block height */}
      <span className="flex items-center gap-1.5" title="Latest Polygon block">
        <span className="text-gray-600">BLOCK</span>
        <span className="text-gray-400">{blockNumber.toLocaleString('en-US').replace(/,/g, ' ')}</span>
      </span>

      <span className="h-3 w-px bg-white/10" />

      {/* Socket state */}
      <span className="flex items-center gap-2">
        <span className={`status-dot ${connected ? 'status-dot-active animate-dot' : 'status-dot-error'}`} />
        <span className={connected ? 'text-green-400' : 'text-red-400'}>
          {connected ? 'LINKED' : 'DOWN'}
        </span>
      </span>
    </div>
  );
}
