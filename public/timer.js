const socket = io(window.location.origin, {transports: ['websocket', 'polling']});