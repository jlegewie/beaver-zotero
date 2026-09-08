import Foundation

/// Bounded responses and no redirects for the private loopback control protocol.
final class VoiceHTTPClient: NSObject, URLSessionDataDelegate {
    private final class Pending {
        let done = DispatchSemaphore(value: 0)
        var data = Data()
        var response: HTTPURLResponse?
        var failed = false
    }
    private let lock = NSLock()
    private var pending: [Int: Pending] = [:]
    private let limit = 1024
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1
        config.timeoutIntervalForResource = 1.5
        config.httpMaximumConnectionsPerHost = 2
        config.connectionProxyDictionary = [:]
        config.httpCookieStorage = nil
        config.urlCache = nil
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    override init() {
        super.init()
        // Initialize before the independent event/control queues can enter execute.
        _ = session
    }

    func execute(_ request: URLRequest) -> (Data, HTTPURLResponse)? {
        let state = Pending()
        let task = session.dataTask(with: request)
        lock.lock(); pending[task.taskIdentifier] = state; lock.unlock()
        task.resume()
        if state.done.wait(timeout: .now() + 1.5) == .timedOut {
            lock.lock(); pending.removeValue(forKey: task.taskIdentifier); lock.unlock()
            task.cancel()
            return nil
        }
        // didComplete publishes these fields before signaling the semaphore.
        guard !state.failed, let response = state.response else { return nil }
        return (state.data, response)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        guard let state = pending[dataTask.taskIdentifier],
              let http = response as? HTTPURLResponse,
              response.expectedContentLength <= Int64(limit) else {
            pending[dataTask.taskIdentifier]?.failed = true
            lock.unlock(); completionHandler(.cancel); return
        }
        state.response = http
        lock.unlock(); completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard let state = pending[dataTask.taskIdentifier] else {
            lock.unlock(); dataTask.cancel(); return
        }
        if state.failed || data.count > limit - state.data.count {
            state.failed = true
            lock.unlock(); dataTask.cancel(); return
        }
        state.data.append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let state = pending.removeValue(forKey: task.taskIdentifier)
        if error != nil { state?.failed = true }
        lock.unlock()
        state?.done.signal()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        lock.lock(); pending[task.taskIdentifier]?.failed = true; lock.unlock()
        completionHandler(nil)
        task.cancel()
    }
}
